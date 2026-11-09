import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
    ownerDatabaseUrl: string;
  }
}

const initSql = readFileSync('docker/postgres/init.sql', 'utf8');
const minimumServerVersion = 180_000;

interface TestDatabase {
  ownerUrl: string;
  teardown: () => Promise<void>;
}

async function startContainer(): Promise<TestDatabase> {
  const container = await new PostgreSqlContainer('postgres:18-alpine')
    .withUsername('agent_owner')
    .withPassword('agent_owner_dev_password')
    .withDatabase('agent')
    .withCopyContentToContainer([
      { content: initSql, target: '/docker-entrypoint-initdb.d/init.sql' },
    ])
    .start();
  return {
    ownerUrl: container.getConnectionUri(),
    teardown: async () => {
      await container.stop();
    },
  };
}

async function createTemporaryDatabase(adminUrl: string): Promise<TestDatabase> {
  const name = `agent_test_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    const { rows } = await admin.query<{ version: number }>(
      "select current_setting('server_version_num')::int as version",
    );
    if (!(Number(rows[0]?.version) >= minimumServerVersion)) {
      throw new Error('TEST_DATABASE_URL must point to Postgres 18 or later, which has uuidv7().');
    }
    await admin.query(`create database ${name}`);
  } finally {
    await admin.end();
  }

  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const owner = new pg.Client({ connectionString: url.toString() });
  await owner.connect();
  try {
    await owner.query(initSql);
  } finally {
    await owner.end();
  }

  return {
    ownerUrl: url.toString(),
    teardown: async () => {
      const cleanup = new pg.Client({ connectionString: adminUrl });
      await cleanup.connect();
      try {
        await cleanup.query(`drop database if exists ${name} with (force)`);
      } finally {
        await cleanup.end();
      }
    },
  };
}

export default async function setup(project: TestProject) {
  const adminUrl = process.env.TEST_DATABASE_URL;
  const database = adminUrl ? await createTemporaryDatabase(adminUrl) : await startContainer();

  const appUrl = new URL(database.ownerUrl);
  appUrl.username = 'agent_app';
  appUrl.password = 'agent_app_dev_password';

  try {
    execFileSync('node', ['src/db/migrate.ts'], {
      env: { ...process.env, MIGRATION_DATABASE_URL: database.ownerUrl },
      stdio: 'inherit',
    });
  } catch (error) {
    await database.teardown();
    throw error;
  }

  project.provide('databaseUrl', appUrl.toString());
  project.provide('ownerDatabaseUrl', database.ownerUrl);
  return database.teardown;
}
