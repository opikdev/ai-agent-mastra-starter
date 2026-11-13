import { httpInstrumentationMiddleware } from '@hono/otel';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { requestId } from 'hono/request-id';
import { secureHeaders } from 'hono/secure-headers';
import { createBudget } from './agent/budget.ts';
import type { Assistant } from './agent/mastra.ts';
import { createRuns } from './agent/runs.ts';
import type { Config } from './config.ts';
import type { Db } from './db/client.ts';
import { createAgentRoutes } from './http/agent-routes.ts';
import { mountApiDocs } from './http/api-docs.ts';
import { createRequireAuth } from './http/auth.ts';
import { createErrorHandler, respond } from './http/error-handler.ts';
import { createHealthRoutes } from './http/health.ts';
import { describeApi } from './http/openapi.ts';
import { rateLimit } from './http/rate-limit.ts';
import { createRouter } from './http/router.ts';
import type { Logger } from './platform/logger.ts';
import { createRunMetrics } from './platform/metrics.ts';
import { ProblemError } from './platform/problem.ts';
import { project } from './platform/project.ts';
import type { Readiness } from './platform/shutdown.ts';

const maxBodyBytes = 64 * 1024;
const healthPaths = new Set(['/healthz', '/readyz']);
const apiContentSecurityPolicy = "default-src 'none'; frame-ancestors 'none'";
/** How long after its timeout a run's row counts as abandoned by a dead process. */
const staleMarginMs = 30_000;

/** Every response header a browser client may need to read. */
const exposedHeaders = [
  'X-Request-Id',
  'Location',
  'Retry-After',
  'RateLimit',
  'RateLimit-Policy',
  'WWW-Authenticate',
];

export interface AppDependencies {
  config: Config;
  db: Db;
  logger: Logger;
  agent: Assistant;
  fetch?: typeof fetch;
  shutdownSignal?: AbortSignal;
  readiness?: Readiness;
}

export function createApp({
  config,
  db,
  logger,
  agent,
  fetch: fetcher,
  shutdownSignal = new AbortController().signal,
  readiness = { draining: false },
}: AppDependencies) {
  const app = createRouter();
  const trustedProxyHops = config.TRUST_PROXY_HOPS;

  const instrumentation = httpInstrumentationMiddleware();
  app.use((c, next) => (healthPaths.has(c.req.path) ? next() : instrumentation(c, next)));
  app.use(requestId());
  app.use(async (c, next) => {
    const startedAt = performance.now();
    await next();
    const level = healthPaths.has(c.req.path) ? 'debug' : 'info';
    logger[level](
      {
        requestId: c.get('requestId'),
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        durationMs: Math.round(performance.now() - startedAt),
      },
      'Request completed',
    );
  });
  app.use(secureHeaders());
  app.use(async (c, next) => {
    await next();
    if (!c.res.headers.has('Content-Security-Policy')) {
      c.header('Content-Security-Policy', apiContentSecurityPolicy);
    }
  });
  if (config.CORS_ORIGINS.length > 0) {
    app.use('/v1/*', cors({ origin: config.CORS_ORIGINS, exposeHeaders: exposedHeaders }));
  }
  app.use('/v1/*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
  });
  app.use(
    '/v1/*',
    bodyLimit({
      maxSize: maxBodyBytes,
      onError: () => {
        throw new ProblemError(
          'payload-too-large',
          `The request body is over the ${maxBodyBytes}-byte limit.`,
        );
      },
    }),
  );
  app.use(
    '/v1/*',
    rateLimit({ db, name: 'global', limit: config.RATE_LIMIT_PER_MINUTE, trustedProxyHops }),
  );

  const budget = createBudget(db, {
    dailyTokens: config.DAILY_TOKEN_BUDGET,
    runTokenLimit: config.AGENT_RUN_TOKEN_LIMIT,
    maxConcurrentRuns: config.AGENT_MAX_CONCURRENT_RUNS,
    staleAfterMs: config.AGENT_RUN_TIMEOUT_MS + staleMarginMs,
  });
  const agentRoutes = createAgentRoutes({
    agent,
    runs: createRuns(db, budget, config.AGENT_RUN_TIMEOUT_MS + staleMarginMs),
    budget,
    logger,
    metrics: createRunMetrics(config.AGENT_MODEL),
    limits: {
      maxSteps: config.AGENT_MAX_STEPS,
      maxOutputTokens: config.AGENT_MAX_OUTPUT_TOKENS,
      runTimeoutMs: config.AGENT_RUN_TIMEOUT_MS,
    },
    recordContent: config.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT,
    requireAuth: createRequireAuth({
      notesApiUrl: config.NOTES_API_URL,
      timeoutMs: config.NOTES_API_TIMEOUT_MS,
      ...(fetcher ? { fetch: fetcher } : {}),
    }),
    agentRateLimit: rateLimit({
      db,
      name: 'agent',
      limit: config.AGENT_RATE_LIMIT_PER_MINUTE,
      perUser: true,
      trustedProxyHops,
    }),
    shutdownSignal,
  });

  app.route('/', createHealthRoutes(db, readiness));
  app.route('/v1', agentRoutes);

  if (config.DOCS_ENABLED) {
    const document = describeApi(app, { title: project.name, version: project.version });
    app.get('/openapi.json', (c) => c.json(document));
    mountApiDocs(app, project.name);
  }

  app.notFound((c) =>
    respond(c, new ProblemError('not-found', `No route matches ${c.req.method} ${c.req.path}.`)),
  );
  app.onError(createErrorHandler(logger));
  return app;
}
