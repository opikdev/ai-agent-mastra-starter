import { setTimeout as sleep } from 'node:timers/promises';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { createStore } from '../agent/mastra.ts';

const migrationLockKey = 72_616_394_212;

const connectionString = process.env.MIGRATION_DATABASE_URL;
if (!connectionString) {
  throw new Error('MIGRATION_DATABASE_URL is required to run migrations');
}

// One runner at a time: a second waits for the lock, then finds nothing to apply. It polls with
// pg_try_advisory_lock, because a session blocked inside pg_advisory_lock holds a snapshot, and
// Mastra's CREATE INDEX CONCURRENTLY would wait for it forever. DDL gives up after 5 seconds
// instead of queueing behind a long query and blocking everything behind it.
async function lock(client: pg.Client) {
  for (;;) {
    const { rows } = await client.query<{ locked: boolean }>(
      'select pg_try_advisory_lock($1) as locked',
      [migrationLockKey],
    );
    if (rows[0]?.locked) return;
    await sleep(500);
  }
}

const client = new pg.Client({ connectionString, statement_timeout: 300_000 });
const pool = new pg.Pool({ connectionString, max: 1, options: '-c lock_timeout=5s' });
await client.connect();
try {
  await lock(client);
  await client.query("set lock_timeout = '5s'");
  await migrate(drizzle({ client }), { migrationsFolder: 'migrations' });
  // Mastra creates and upgrades its own tables. The app's role can't, so this runs here.
  await createStore(pool, true).init();
  console.log('Migrations applied');
} finally {
  await client.end();
  await pool.end();
}
