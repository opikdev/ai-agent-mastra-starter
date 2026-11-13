import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { Assistant } from '../../src/agent/mastra.ts';
import { createApp } from '../../src/app.ts';
import { createLogger } from '../../src/platform/logger.ts';
import { eventsOf, json, startStack, type TestStack, uniqueIp } from '../helpers.ts';

let stack: TestStack;
beforeAll(async () => {
  stack = await startStack({ CORS_ORIGINS: 'https://app.example.com' });
});
afterAll(() => stack.close());

describe('http', () => {
  it('boots and answers with the values shipped in .env.example', async () => {
    const shipped = parseEnv(readFileSync('.env.example', 'utf8')) as Record<string, string>;
    const booted = await startStack({
      ...shipped,
      DATABASE_URL: inject('databaseUrl'),
      NOTES_API_URL: 'http://notes.test',
      ANTHROPIC_API_KEY: 'test-anthropic-key',
      LOG_LEVEL: 'silent',
      // app.request() has no socket, so the client IP must come from X-Forwarded-For.
      TRUST_PROXY_HOPS: '1',
    });
    try {
      expect((await booted.app.request('/readyz')).status).toBe(200);
      const user = booted.signUp();
      const thread = await user.createThread();
      const events = await user.say(thread.id, 'Hi');
      expect(events.at(-1)).toMatchObject({ event: 'done', data: { status: 'completed' } });
    } finally {
      await booted.close();
    }
  });

  it('answers CORS preflights for allowed origins', async () => {
    const response = await stack.app.request('/v1/threads', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://app.example.com',
        'Access-Control-Request-Method': 'POST',
        'X-Forwarded-For': uniqueIp(),
      },
    });
    expect(response.headers.get('access-control-allow-origin')).toBe('https://app.example.com');
  });

  it('lets browsers read the request ID, location, and rate limit headers', async () => {
    const user = stack.signUp();
    const response = await user.request('/v1/threads', {
      method: 'POST',
      json: {},
      headers: { Origin: 'https://app.example.com' },
    });
    const exposed = response.headers.get('access-control-expose-headers')?.split(',') ?? [];
    expect(exposed.map((header) => header.trim().toLowerCase()).sort()).toEqual([
      'location',
      'ratelimit',
      'ratelimit-policy',
      'retry-after',
      'www-authenticate',
      'x-request-id',
    ]);
    for (const header of ['x-request-id', 'location', 'ratelimit', 'ratelimit-policy']) {
      expect(response.headers.get(header), header).toBeTruthy();
    }
  });

  it('marks /v1 responses no-store, and every response with a deny-all CSP', async () => {
    const user = stack.signUp();
    const response = await user.request('/v1/threads');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-security-policy')).toBe(
      "default-src 'none'; frame-ancestors 'none'",
    );
    const health = await stack.app.request('/healthz');
    expect(health.headers.get('content-security-policy')).toBe(
      "default-src 'none'; frame-ancestors 'none'",
    );
    const problem = await stack.app.request('/v1/threads', {
      headers: { 'X-Forwarded-For': uniqueIp() },
    });
    expect(problem.headers.get('cache-control')).toBe('no-store');
  });

  it.each([
    ['text/plain', 'text/plain'],
    ['a form, as curl -d sends by default', 'application/x-www-form-urlencoded'],
  ])('rejects %s with 415, not 500', async (_label, contentType) => {
    const user = stack.signUp();
    const response = await user.request('/v1/threads', {
      method: 'POST',
      body: 'title=x',
      headers: { 'Content-Type': contentType },
    });
    expect(response.status).toBe(415);
    expect((await json(response)).type).toBe('urn:problem:unsupported-media-type');
  });

  it('rejects malformed JSON with 400', async () => {
    const user = stack.signUp();
    const response = await user.request('/v1/threads', {
      method: 'POST',
      body: '{ nope',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(response.status).toBe(400);
    expect((await json(response)).detail).toContain('not valid JSON');
  });

  it('rejects a body over 64 KiB', async () => {
    const user = stack.signUp();
    const response = await user.request('/v1/threads', {
      method: 'POST',
      json: { title: 'x'.repeat(70_000) },
    });
    expect(response.status).toBe(413);
  });

  it('hides unexpected errors behind a request ID and logs them', async () => {
    const lines: string[] = [];
    const broken = {
      getMemory: async () => {
        throw new Error('database exploded');
      },
    } as unknown as Assistant;
    const app = createApp({
      config: stack.config,
      db: stack.db,
      logger: createLogger('error', { write: (line: string) => void lines.push(line) }),
      agent: broken,
      fetch: stack.notesApi.fetch,
    });
    const user = stack.signUp();
    const response = await app.request('/v1/threads', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${user.token}`,
        'Content-Type': 'application/json',
        'X-Forwarded-For': uniqueIp(),
      },
      body: '{}',
    });
    expect(response.status).toBe(500);
    const problem = await json(response);
    expect(problem.detail).not.toContain('exploded');
    expect(problem.detail).toContain(response.headers.get('x-request-id'));
    expect(lines.join('')).toContain('database exploded');
  });

  it('updates a note after approval, using the note’s current version', async () => {
    const user = stack.signUp();
    stack.notesApi.notes.set(user.id, [
      { id: 'note_5', title: 'Plan', body: 'old', version: 3, createdAt: 'x', updatedAt: 'x' },
    ]);
    const thread = await user.createThread();
    stack.reply({ tool: { name: 'updateNote', input: { id: 'note_5', body: 'new' } } });
    const paused = await user.say(thread.id, 'Change the plan to new');
    const [approval] = eventsOf(paused, 'approval-required');
    stack.reply({ text: 'Updated.' });
    await user.decide(approval.runId, approval.toolCallId, true);
    expect(stack.notesApi.notes.get(user.id)?.[0]).toMatchObject({ body: 'new', version: 4 });
  });
});
