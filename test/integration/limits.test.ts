import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runs } from '../../src/db/schema.ts';
import { eventsOf, json, startStack, type TestStack, uniqueIp } from '../helpers.ts';

describe('auth', () => {
  let stack: TestStack;
  beforeAll(async () => {
    stack = await startStack();
  });
  afterAll(() => stack.close());

  it.each([
    ['no header', {}],
    ['another scheme', { Authorization: 'Basic abc' }],
    ['an extra part', { Authorization: 'Bearer a b' }],
    ['a token the notes API rejects', { Authorization: 'Bearer nope' }],
    ['a very long token', { Authorization: `Bearer ${'x'.repeat(513)}` }],
  ])('rejects %s with 401', async (_label, headers) => {
    const response = await stack.app.request('/v1/threads', {
      headers: { 'X-Forwarded-For': uniqueIp(), ...headers },
    });
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe('Bearer');
    expect((await json(response)).type).toBe('urn:problem:unauthorized');
  });

  it('returns 503 when the notes API can’t confirm the token', async () => {
    const user = stack.signUp();
    stack.notesApi.failNext(500);
    const response = await user.request('/v1/threads');
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('5');
  });

  it('checks each token with the notes API once, then caches it', async () => {
    const user = stack.signUp();
    const before = stack.notesApi.requests.length;
    await user.request('/v1/threads');
    await user.request('/v1/threads');
    const checks = stack.notesApi.requests
      .slice(before)
      .filter((request) => new URL(request.url).pathname === '/v1/users/me');
    expect(checks).toHaveLength(1);
  });

  it('answers health checks without a token', async () => {
    expect(await json(await stack.app.request('/healthz'))).toEqual({ status: 'ok' });
    expect(await json(await stack.app.request('/readyz'))).toEqual({ status: 'ok' });
  });

  it('returns Problem Details for an unknown route', async () => {
    const response = await stack.app.request('/nope');
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toBe('application/problem+json');
  });
});

describe('budgets and rate limits', () => {
  let stack: TestStack;
  beforeAll(async () => {
    stack = await startStack({ DAILY_TOKEN_BUDGET: '200', AGENT_RATE_LIMIT_PER_MINUTE: '3' });
  });
  afterAll(() => stack.close());

  it('refuses new runs once the day’s budget is spent', async () => {
    const user = stack.signUp();
    const thread = await user.createThread();
    await user.say(thread.id, 'one');
    await user.say(thread.id, 'two');
    const response = await user.request(`/v1/threads/${thread.id}/messages`, {
      method: 'POST',
      json: { content: 'three' },
    });
    expect(response.status).toBe(429);
    expect((await json(response)).type).toBe('urn:problem:budget-exceeded');
    expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await (await user.request('/v1/usage')).json()).toEqual({
      inputTokens: 200,
      outputTokens: 40,
      dailyBudget: 200,
      remaining: 0,
    });
  });

  it('keeps budgets per user', async () => {
    const user = stack.signUp();
    const thread = await user.createThread();
    expect(eventsOf(await user.say(thread.id, 'hi'), 'done')[0].status).toBe('completed');
  });

  it('limits agent requests per user per minute', async () => {
    const user = stack.signUp();
    const statuses: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      const response = await user.request(
        '/v1/threads/thr_00000000000000000000000000000000/messages',
        {
          method: 'POST',
          json: { content: 'hi' },
        },
      );
      statuses.push(response.status);
      if (i === 3) expect(response.headers.get('retry-after')).toBeTruthy();
    }
    expect(statuses).toEqual([404, 404, 404, 429]);
  });
});

describe('failures', () => {
  let stack: TestStack;
  beforeAll(async () => {
    stack = await startStack();
  });
  afterAll(() => stack.close());

  it('reports a model provider failure as an error event, and logs it without the prompt', async () => {
    const user = stack.signUp();
    const thread = await user.createThread();
    stack.reply({ status: 400, error: 'invalid request' });
    const events = await user.say(thread.id, 'my secret plans');
    expect(eventsOf(events, 'error')[0]).toMatchObject({
      type: 'urn:problem:service-unavailable',
      status: 503,
    });
    expect(eventsOf(events, 'done')[0].status).toBe('failed');
    const failure = stack.logs.find((line) => line.includes('Agent run failed'));
    expect(JSON.parse(failure ?? '{}').err).toMatchObject({ statusCode: 400, isRetryable: false });
    expect(stack.logs.join('')).not.toContain('my secret plans');
    expect(stack.logs.join('')).not.toContain('You are a notes assistant');
    const next = await user.say(thread.id, 'again');
    expect(eventsOf(next, 'done')[0].status).toBe('completed');
  });

  it('gives a notes API failure back to the model as data', async () => {
    const user = stack.signUp();
    const thread = await user.createThread();
    stack.reply({ tool: { name: 'getNote', input: { id: 'note_404' } } }, { text: 'Not found.' });
    const events = await user.say(thread.id, 'Open note_404');
    expect(eventsOf(events, 'tool-result')[0].result).toEqual({
      error: 'Note note_404 does not exist.',
    });
    expect(eventsOf(events, 'done')[0].status).toBe('completed');
  });
});

describe('timeouts', () => {
  let stack: TestStack;
  beforeAll(async () => {
    stack = await startStack({ AGENT_RUN_TIMEOUT_MS: '300' });
  });
  afterAll(() => stack.close());

  it('stops a run that takes too long', async () => {
    const user = stack.signUp();
    const thread = await user.createThread();
    stack.anthropic.delayMs = 1000;
    const events = await user.say(thread.id, 'hi');
    stack.anthropic.delayMs = 0;
    expect(eventsOf(events, 'error')[0].detail).toContain('0.3 seconds');
    expect(eventsOf(events, 'done')[0].status).toBe('aborted');
  });
});

describe('a timeout during a tool call', () => {
  let stack: TestStack;
  beforeAll(async () => {
    stack = await startStack({ AGENT_RUN_TIMEOUT_MS: '3000' });
  });
  afterAll(() => stack.close());

  it('cancels the notes API call', async () => {
    const user = stack.signUp();
    const thread = await user.createThread();
    stack.reply({ tool: { name: 'getNote', input: { id: 'note_1' } } });
    stack.notesApi.delayMs = 10_000;
    const events = await user.say(thread.id, 'Open note_1');
    stack.notesApi.delayMs = 0;
    expect(eventsOf(events, 'done')[0].status).toBe('aborted');
    const call = stack.notesApi.requests.findLast(
      (request) => new URL(request.url).pathname === '/v1/notes/note_1',
    );
    expect(call).toBeDefined();
    expect(call?.signal.aborted).toBe(true);
  });
});

describe('shutdown', () => {
  let stack: TestStack;
  beforeAll(async () => {
    stack = await startStack();
  });
  afterAll(() => stack.close());

  it('ends an open run as failed, so its thread is free for the next process', async () => {
    const user = stack.signUp();
    const thread = await user.createThread();
    const before = stack.anthropic.requests.length;
    stack.anthropic.delayMs = 5000;
    const reply = user.say(thread.id, 'hi');
    await vi.waitFor(() => expect(stack.anthropic.requests.length).toBeGreaterThan(before));
    stack.shutdown.abort();
    const events = await reply;
    stack.anthropic.delayMs = 0;

    expect(eventsOf(events, 'error')[0]).toMatchObject({
      type: 'urn:problem:service-unavailable',
      detail: 'The server shut down during this run. Send your message again.',
    });
    expect(eventsOf(events, 'done')[0].status).toBe('aborted');
    const rows = await stack.db.select().from(runs).where(eq(runs.threadId, thread.id));
    expect(rows.map((row) => row.status)).toEqual(['failed']);
  });
});
