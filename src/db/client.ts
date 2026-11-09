import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.ts';

export function createPool(
  connectionString: string,
  statementTimeoutMs: number,
  max = 10,
): pg.Pool {
  return new pg.Pool({
    connectionString,
    max,
    connectionTimeoutMillis: 5000,
    statement_timeout: statementTimeoutMs,
  });
}

export function createDb(pool: pg.Pool) {
  return drizzle({ client: pool, schema });
}

export type Db = ReturnType<typeof createDb>;
