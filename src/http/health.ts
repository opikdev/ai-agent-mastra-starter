import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import type { Db } from '../db/client.ts';
import type { AppEnv } from './env.ts';
import { ProblemError } from './problem.ts';

export function createHealthRoutes(db: Db) {
  return new Hono<AppEnv>()
    .get('/healthz', (c) => c.json({ status: 'ok' as const }))
    .get('/readyz', async (c) => {
      try {
        await db.execute(sql`select 1`);
      } catch (cause) {
        throw new ProblemError('service-unavailable', 'Postgres is unreachable. Retry shortly.', {
          headers: { 'Retry-After': '5' },
          cause,
        });
      }
      return c.json({ status: 'ok' as const });
    });
}
