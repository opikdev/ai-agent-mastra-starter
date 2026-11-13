import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import pg from 'pg';
import { describe, expect, inject, it } from 'vitest';

const run = promisify(execFile);

function migrate(url: string) {
  return run('node', ['src/db/migrate.ts'], {
    env: { ...process.env, MIGRATION_DATABASE_URL: url },
  });
}

async function withClient<T>(url: string, use: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await use(client);
  } finally {
    await client.end();
  }
}

async function columns(url: string) {
  const { rows } = await withClient(url, (client) =>
    client.query(
      "select table_name, column_name, data_type from information_schema.columns where table_schema = 'public' order by table_name, column_name",
    ),
  );
  return rows;
}

describe('migration runner', () => {
  it('gives up on a held lock instead of queueing behind it', async () => {
    const ownerUrl = inject('ownerDatabaseUrl');
    const blocker = new pg.Client({ connectionString: ownerUrl });
    await blocker.connect();
    try {
      await blocker.query('begin');
      await blocker.query('lock table drizzle.__drizzle_migrations in access exclusive mode');
      await expect(migrate(ownerUrl)).rejects.toThrow(/lock timeout/);
    } finally {
      await blocker.query('rollback');
      await blocker.end();
    }
  });

  it('runs once when two runners start together on an empty database', async () => {
    const ownerUrl = inject('ownerDatabaseUrl');
    const name = `migrate_race_${randomBytes(4).toString('hex')}`;
    await withClient(ownerUrl, (client) => client.query(`create database ${name}`));
    const url = new URL(ownerUrl);
    url.pathname = `/${name}`;
    try {
      const initSql = readFileSync('docker/postgres/init.sql', 'utf8');
      await withClient(url.toString(), (client) => client.query(initSql));
      const outcomes = await Promise.allSettled([migrate(url.toString()), migrate(url.toString())]);
      expect(outcomes.map((outcome) => outcome.status)).toEqual(['fulfilled', 'fulfilled']);

      const migrations = readdirSync('migrations').filter((file) => file.endsWith('.sql'));
      const applied = await withClient(url.toString(), (client) =>
        client.query('select hash from drizzle.__drizzle_migrations'),
      );
      expect(applied.rowCount).toBe(migrations.length);
      expect(await columns(url.toString())).toEqual(await columns(ownerUrl));
    } finally {
      await withClient(ownerUrl, (client) =>
        client.query(`drop database if exists ${name} with (force)`),
      );
    }
  }, 60_000);
});
