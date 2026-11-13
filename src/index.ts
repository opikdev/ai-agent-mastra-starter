import { serve } from '@hono/node-server';
import { createBudget } from './agent/budget.ts';
import { createMastra } from './agent/mastra.ts';
import { deleteInactiveThreads } from './agent/retention.ts';
import { createRuns } from './agent/runs.ts';
import { createApp } from './app.ts';
import { loadConfig } from './config.ts';
import { createDb, createPool } from './db/client.ts';
import { deleteExpiredRows } from './platform/cleanup.ts';
import { createLogger } from './platform/logger.ts';
import { type Readiness, shutdown } from './platform/shutdown.ts';

const cleanupIntervalMs = 60 * 60 * 1000;
const staleMarginMs = 30_000;
/** Time aborted runs get to save their status and send their last events. */
const settleMs = 5_000;
const closeMarginMs = 10_000;

// Model providers read their settings straight from the environment, where empty means unset.
for (const [name, value] of Object.entries(process.env)) {
  if (value === '') delete process.env[name];
}

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL);
const pool = createPool(
  config.DATABASE_URL,
  config.DATABASE_STATEMENT_TIMEOUT_MS,
  config.DATABASE_POOL_MAX,
);
pool.on('error', (err) => logger.error({ err }, 'Idle database connection failed'));
const db = createDb(pool);
const { mastra, agent } = createMastra(config, pool);
const stopping = new AbortController();
const readiness: Readiness = { draining: false };
const app = createApp({ config, db, logger, agent, shutdownSignal: stopping.signal, readiness });

const server = serve({ fetch: app.fetch, port: config.PORT }, ({ port }) => {
  logger.info({ port, model: config.AGENT_MODEL }, 'Server listening');
});

const staleRunMs = config.AGENT_RUN_TIMEOUT_MS + staleMarginMs;
const runs = createRuns(
  db,
  createBudget(db, {
    dailyTokens: config.DAILY_TOKEN_BUDGET,
    runTokenLimit: config.AGENT_RUN_TOKEN_LIMIT,
    maxConcurrentRuns: config.AGENT_MAX_CONCURRENT_RUNS,
    staleAfterMs: staleRunMs,
  }),
  staleRunMs,
);

async function cleanUp() {
  const retention = {
    runRetentionDays: config.RUN_RETENTION_DAYS,
    approvalTtlHours: config.APPROVAL_TTL_HOURS,
    staleRunMs,
  };
  const cleaned = await deleteExpiredRows(db, retention);
  if (cleaned && config.THREAD_RETENTION_DAYS > 0) {
    const threads = await deleteInactiveThreads(agent, runs, config.THREAD_RETENTION_DAYS);
    if (threads > 0) logger.info({ threads }, 'Deleted inactive threads');
  }
}

const cleanup = setInterval(() => {
  cleanUp().catch((err) => logger.error({ err }, 'Cleanup failed'));
}, cleanupIntervalMs);
cleanup.unref();

let stoppingStarted = false;

/**
 * Drains, lets runs in flight finish until the timeout, then aborts the rest. Aborted runs end as
 * failed with reason `shutdown`, free their reserved tokens, and tell their clients.
 */
function stop(signal: NodeJS.Signals) {
  if (stoppingStarted) return;
  stoppingStarted = true;
  const drainMs = config.SHUTDOWN_DRAIN_SECONDS * 1000;
  const timeoutMs = config.SHUTDOWN_TIMEOUT_SECONDS * 1000;
  const deadlineMs = drainMs + timeoutMs + settleMs + closeMarginMs;
  logger.info({ signal, drainMs, timeoutMs }, 'Draining, then shutting down');
  clearInterval(cleanup);
  setTimeout(() => {
    logger.error({ deadlineMs }, 'Shutdown timed out');
    process.exit(1);
  }, deadlineMs).unref();
  shutdown({
    server,
    readiness,
    drainMs,
    timeoutMs,
    settleMs,
    abortInFlight: () => {
      logger.warn({ timeoutMs }, 'Aborting runs still in flight');
      stopping.abort();
    },
    close: async () => {
      await mastra.shutdown();
      await pool.end();
    },
  }).then(
    () => process.exit(0),
    (err: unknown) => {
      logger.error({ err }, 'Shutdown failed');
      process.exit(1);
    },
  );
}

process.once('SIGTERM', stop);
process.once('SIGINT', stop);
