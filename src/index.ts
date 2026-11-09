import { serve } from '@hono/node-server';
import { lte, sql } from 'drizzle-orm';
import { createMastra } from './agent/mastra.ts';
import { createApp } from './app.ts';
import { loadConfig } from './config.ts';
import { createDb, createPool } from './db/client.ts';
import { rateLimits } from './db/schema.ts';
import { createLogger } from './http/logger.ts';

const cleanupIntervalMs = 60 * 60 * 1000;

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL);
const pool = createPool(config.DATABASE_URL, config.DATABASE_STATEMENT_TIMEOUT_MS);
pool.on('error', (err) => logger.error({ err }, 'Idle database connection failed'));
const db = createDb(pool);
const { mastra, agent } = createMastra(config, pool);
const app = createApp({ config, db, logger, agent });

const server = serve({ fetch: app.fetch, port: config.PORT }, ({ port }) => {
  logger.info({ port, model: config.AGENT_MODEL }, 'Server listening');
});

const cleanup = setInterval(() => {
  db.delete(rateLimits)
    .where(lte(rateLimits.resetAt, sql`now()`))
    .catch((err) => logger.error({ err }, 'Cleanup failed'));
}, cleanupIntervalMs);
cleanup.unref();

function shutdown(signal: string) {
  logger.info({ signal }, 'Shutting down');
  clearInterval(cleanup);
  server.close(() => {
    mastra
      .shutdown()
      .catch((err) => logger.error({ err }, 'Mastra shutdown failed'))
      .finally(() => pool.end().finally(() => process.exit(0)));
  });
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
