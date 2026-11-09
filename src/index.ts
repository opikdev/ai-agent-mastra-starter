import { serve } from '@hono/node-server';
import { createMastra } from './agent/mastra.ts';
import { createApp } from './app.ts';
import { loadConfig } from './config.ts';
import { createDb, createPool } from './db/client.ts';
import { deleteExpiredRows } from './platform/cleanup.ts';
import { createLogger } from './platform/logger.ts';

const cleanupIntervalMs = 60 * 60 * 1000;
const shutdownTimeoutMs = 9000;

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
const app = createApp({ config, db, logger, agent, shutdownSignal: stopping.signal });

const server = serve({ fetch: app.fetch, port: config.PORT }, ({ port }) => {
  logger.info({ port, model: config.AGENT_MODEL }, 'Server listening');
});

const retention = {
  runRetentionDays: config.RUN_RETENTION_DAYS,
  approvalTtlHours: config.APPROVAL_TTL_HOURS,
};
const cleanup = setInterval(() => {
  deleteExpiredRows(db, retention).catch((err) => logger.error({ err }, 'Cleanup failed'));
}, cleanupIntervalMs);
cleanup.unref();

/** Ends open runs as failed, waits for their streams to close, then exits before a SIGKILL. */
function shutdown(signal: string) {
  logger.info({ signal }, 'Shutting down');
  setTimeout(() => {
    logger.error({ timeoutMs: shutdownTimeoutMs }, 'Shutdown took too long, so exiting now');
    process.exit(1);
  }, shutdownTimeoutMs).unref();
  clearInterval(cleanup);
  stopping.abort();
  server.close(() => {
    mastra
      .shutdown()
      .catch((err) => logger.error({ err }, 'Mastra shutdown failed'))
      .finally(() => pool.end().finally(() => process.exit(0)));
  });
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
