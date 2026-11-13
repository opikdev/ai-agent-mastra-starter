import { randomBytes, randomUUID } from 'node:crypto';
import { inject } from 'vitest';
import { type Assistant, createMastra } from '../src/agent/mastra.ts';
import { createApp } from '../src/app.ts';
import { type Config, loadConfig } from '../src/config.ts';
import { createDb, createPool, type Db } from '../src/db/client.ts';
import { createLogger } from '../src/platform/logger.ts';
import type { Readiness } from '../src/platform/shutdown.ts';
import { type FakeAnthropic, type Reply, startFakeAnthropic } from './fake-anthropic.ts';
import { createFakeNotesApi, type FakeNotesApi } from './fake-notes-api.ts';

// biome-ignore lint/suspicious/noExplicitAny: tests read arbitrary response JSON.
export type Json = any;

export type TestResponse = Omit<Response, 'json'> & { json(): Promise<Json> };

export function json(response: Response): Promise<Json> {
  return response.json();
}

export interface SseEvent {
  event: string;
  data: Json;
}

export async function readSse(response: { text(): Promise<string> }): Promise<SseEvent[]> {
  const text = await response.text();
  return text
    .split('\n\n')
    .filter((frame) => frame.trim())
    .map((frame) => {
      const lines = frame.split('\n');
      const event =
        lines
          .find((line) => line.startsWith('event:'))
          ?.slice(6)
          .trim() ?? 'message';
      const data = lines
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('\n');
      return { event, data: data ? JSON.parse(data) : null };
    });
}

export interface TestUser {
  id: string;
  token: string;
  request: (path: string, init?: RequestInit & { json?: unknown }) => Promise<TestResponse>;
  createThread: (title?: string) => Promise<{ id: string }>;
  say: (threadId: string, content: string) => Promise<SseEvent[]>;
  decide: (
    runId: string,
    toolCallId: string,
    approved: boolean,
    reason?: string,
  ) => Promise<SseEvent[]>;
}

export interface TestStack {
  anthropic: FakeAnthropic;
  notesApi: FakeNotesApi;
  config: Config;
  db: Db;
  agent: Assistant;
  app: ReturnType<typeof createApp>;
  logs: string[];
  /** Aborting it is what the shutdown timeout does to the real server's runs. */
  shutdown: AbortController;
  readiness: Readiness;
  signUp: () => TestUser;
  reply: (...replies: Reply[]) => void;
  close: () => Promise<void>;
}

/** A random documentation IPv6 address, so each test client gets its own rate limit. */
export function uniqueIp(): string {
  const groups = randomBytes(12).toString('hex').match(/.{4}/g) as string[];
  return `2001:db8:${groups.join(':')}`;
}

let shared: Promise<FakeAnthropic> | undefined;

/** Mastra caches its Anthropic provider, so every stack in a test file shares one fake. */
export function fakeAnthropic(): Promise<FakeAnthropic> {
  shared ??= startFakeAnthropic().then((fake) => {
    process.env.ANTHROPIC_BASE_URL = fake.url;
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
    return fake;
  });
  return shared;
}

export async function startStack(env: Record<string, string> = {}): Promise<TestStack> {
  const anthropic = await fakeAnthropic();
  anthropic.replies.length = 0;
  anthropic.guardScores.length = 0;
  anthropic.delayMs = 0;
  anthropic.guardDelayMs = 0;
  const notesApi = createFakeNotesApi();
  const config = loadConfig({
    DATABASE_URL: inject('databaseUrl'),
    NOTES_API_URL: 'http://notes.test',
    GUARDRAIL_MODEL: 'off',
    LOG_LEVEL: 'silent',
    TRUST_PROXY_HOPS: '1',
    ANTHROPIC_API_KEY: 'test-anthropic-key',
    ...env,
  });
  const pool = createPool(
    config.DATABASE_URL,
    config.DATABASE_STATEMENT_TIMEOUT_MS,
    config.DATABASE_POOL_MAX,
  );
  const db = createDb(pool);
  const logs: string[] = [];
  const logger = createLogger(env.LOG_LEVEL ?? 'debug', {
    write: (line: string) => {
      logs.push(line);
    },
  });
  const { mastra, agent } = createMastra(config, pool);
  const shutdown = new AbortController();
  const readiness: Readiness = { draining: false };
  const app = createApp({
    readiness,
    config,
    db,
    logger,
    agent,
    fetch: notesApi.fetch,
    shutdownSignal: shutdown.signal,
  });

  function signUp(): TestUser {
    const id = `usr_${randomUUID().replaceAll('-', '')}`;
    const token = `token-${randomUUID()}`;
    const ip = uniqueIp();
    notesApi.addUser(id, token);
    const request: TestUser['request'] = (path, { json, headers, ...init } = {}) =>
      Promise.resolve(
        app.request(path, {
          ...init,
          headers: {
            Authorization: `Bearer ${token}`,
            'X-Forwarded-For': ip,
            ...(json === undefined ? {} : { 'Content-Type': 'application/json' }),
            ...headers,
          },
          ...(json === undefined ? {} : { body: JSON.stringify(json) }),
        }),
      ) as Promise<TestResponse>;
    return {
      id,
      token,
      request,
      createThread: async (title) =>
        (await request('/v1/threads', { method: 'POST', json: title ? { title } : {} })).json(),
      say: async (threadId, content) =>
        readSse(
          await request(`/v1/threads/${threadId}/messages`, { method: 'POST', json: { content } }),
        ),
      decide: async (runId, toolCallId, approved, reason) =>
        readSse(
          await request(`/v1/runs/${runId}/approval`, {
            method: 'POST',
            json: { toolCallId, approved, ...(reason ? { reason } : {}) },
          }),
        ),
    };
  }

  return {
    anthropic,
    notesApi,
    config,
    db,
    agent,
    app,
    logs,
    shutdown,
    readiness,
    signUp,
    reply: (...replies) => {
      anthropic.replies.push(...replies);
    },
    close: async () => {
      await mastra.shutdown();
      await pool.end();
    },
  };
}

export function eventsOf(events: SseEvent[], name: string) {
  return events.filter((event) => event.event === name).map((event) => event.data);
}

/** One model role's usage, as the API reports it. */
export function tokens(
  inputTokens: number,
  outputTokens: number,
  cacheReadInputTokens = 0,
  cacheWriteInputTokens = 0,
) {
  return { inputTokens, outputTokens, cacheReadInputTokens, cacheWriteInputTokens };
}

/** A run's or day's usage: totals across the agent and the guardrail, plus each one's share. */
export function runUsage(agent = tokens(0, 0), guardrail = tokens(0, 0)) {
  return {
    inputTokens: agent.inputTokens + guardrail.inputTokens,
    outputTokens: agent.outputTokens + guardrail.outputTokens,
    cacheReadInputTokens: agent.cacheReadInputTokens + guardrail.cacheReadInputTokens,
    cacheWriteInputTokens: agent.cacheWriteInputTokens + guardrail.cacheWriteInputTokens,
    agent,
    guardrail,
  };
}
