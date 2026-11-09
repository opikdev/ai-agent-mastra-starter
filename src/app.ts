import { Hono } from 'hono';
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
import { createRequireAuth } from './http/auth.ts';
import type { AppEnv } from './http/env.ts';
import { createErrorHandler, respond } from './http/error-handler.ts';
import { createHealthRoutes } from './http/health.ts';
import { rateLimit } from './http/rate-limit.ts';
import type { Logger } from './platform/logger.ts';
import { ProblemError } from './platform/problem.ts';

const maxBodyBytes = 64 * 1024;

export interface AppDependencies {
  config: Config;
  db: Db;
  logger: Logger;
  agent: Assistant;
  fetch?: typeof fetch;
  shutdownSignal?: AbortSignal;
}

export function createApp({
  config,
  db,
  logger,
  agent,
  fetch: fetcher,
  shutdownSignal = new AbortController().signal,
}: AppDependencies) {
  const app = new Hono<AppEnv>();
  const trustProxy = config.TRUST_PROXY;

  app.use(requestId());
  app.use(async (c, next) => {
    const startedAt = performance.now();
    await next();
    logger.info(
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
  if (config.CORS_ORIGINS.length > 0) {
    app.use('/v1/*', cors({ origin: config.CORS_ORIGINS }));
  }
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
    rateLimit({ db, name: 'global', limit: config.RATE_LIMIT_PER_MINUTE, trustProxy }),
  );

  const agentRoutes = createAgentRoutes({
    agent,
    runs: createRuns(db, config.AGENT_RUN_TIMEOUT_MS + 30_000),
    budget: createBudget(db, config.DAILY_TOKEN_BUDGET),
    logger,
    limits: {
      maxSteps: config.AGENT_MAX_STEPS,
      maxOutputTokens: config.AGENT_MAX_OUTPUT_TOKENS,
      runTimeoutMs: config.AGENT_RUN_TIMEOUT_MS,
    },
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
      trustProxy,
    }),
    shutdownSignal,
  });

  app.route('/', createHealthRoutes(db));
  app.route('/v1', agentRoutes);

  app.notFound((c) =>
    respond(c, new ProblemError('not-found', `No route matches ${c.req.method} ${c.req.path}.`)),
  );
  app.onError(createErrorHandler(logger));
  return app;
}
