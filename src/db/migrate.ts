import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { createStore } from '../agent/mastra.ts';

const connectionString = process.env.MIGRATION_DATABASE_URL;
if (!connectionString) {
  throw new Error('MIGRATION_DATABASE_URL is required to run migrations');
}

const pool = new pg.Pool({ connectionString, max: 1 });
try {
  await migrate(drizzle({ client: pool }), { migrationsFolder: 'migrations' });
  // Mastra creates and upgrades its own tables. The app's role can't, so this runs here.
  await createStore(pool, true).init();
  console.log('Migrations applied');
} finally {
  await pool.end();
}
