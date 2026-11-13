import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runs } from '../../src/db/schema.ts';
import { eventsOf, json, readSse, startStack, type TestStack, type TestUser } from '../helpers.ts';

async function usageOf(user: TestUser) {
  return (await user.request('/v1/usage')).json();
}

function send(user: TestUser, threadId: string, content: string) {
  return user.request(`/v1/threads/${threadId}/messages`, { method: 'POST', json: { content } });
}

describe('the daily budget', () => {
  let stack: TestStack;
  beforeAll(async () => {
    stack = await startStack({ DAILY_TOKEN_BUDGET: '500', AGENT_RUN_TOKEN_LIMIT: '200' });
  });
  afterAll(() => stack.close());

  it('refuses a run once less than a run’s worth of tokens is left', async () => {
    const user = stack.signUp();
    const thread = await user.createThread();
    for (const content of ['one', 'two', 'three']) {
      expect(eventsOf(await user.say(thread.id, content), 'done')[0].status).toBe('completed');
    }
    const response = await send(user, thread.id, 'four');
    expect(response.status).toBe(429);
    const problem = await json(response);
    expect(problem.type).toBe('urn:problem:budget-exceeded');
    expect(problem.detail).toContain('140');
    expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(5);
    expect(await usageOf(user)).toMatchObject({
      inputTokens: 300,
      outputTokens: 60,
      dailyBudget: 500,
      reserved: 0,
      remaining: 140,
    });
  });

  it('keeps budgets per user', async () => {
    const user = stack.signUp();
    const thread = await user.createThread();
    expect(eventsOf(await user.say(thread.id, 'hi'), 'done')[0].status).toBe('completed');
  });

  it('frees what a dead process reserved, and fails its run', async () => {
    const user = stack.signUp();
    const thread = await user.createThread();
    const [stale] = await stack.db
      .insert(runs)
      .values({
        userId: user.id,
        threadId: `thr_${randomUUID().replaceAll('-', '')}`,
        reservedTokens: 400,
        updatedAt: new Date(Date.now() - 3_600_000),
      })
      .returning();
    expect(eventsOf(await user.say(thread.id, 'hi'), 'done')[0].status).toBe('completed');
    const [row] = await stack.db
      .select()
      .from(runs)
      .where(eq(runs.id, stale?.id as string));
    expect(row).toMatchObject({ status: 'failed', stopReason: 'stale', reservedTokens: 0 });
  });
});

describe('parallel runs', () => {
  let stack: TestStack;
  beforeAll(async () => {
    stack = await startStack({
      DAILY_TOKEN_BUDGET: '1200',
      AGENT_RUN_TOKEN_LIMIT: '400',
      AGENT_MAX_OUTPUT_TOKENS: '100',
      AGENT_MAX_CONCURRENT_RUNS: '20',
      AGENT_RATE_LIMIT_PER_MINUTE: '100',
    });
  });
  afterAll(() => stack.close());

  it('never spend more than the budget, however many start at once', async () => {
    const user = stack.signUp();
    const threads = await Promise.all(Array.from({ length: 10 }, () => user.createThread()));
    stack.anthropic.delayMs = 100;
    try {
      for (let round = 0; round < 3; round += 1) {
        for (const _ of threads) {
          stack.reply({ tool: { name: 'listNotes', input: {} } }, { text: 'None.' });
        }
        const responses = await Promise.all(
          threads.map((thread) => send(user, thread.id, 'What notes do I have?')),
        );
        const started = responses.filter((response) => response.status === 200);
        const refused = responses.filter((response) => response.status === 429);
        expect(started.length + refused.length).toBe(threads.length);
        for (const response of refused) {
          expect((await json(response)).type).toBe('urn:problem:budget-exceeded');
        }
        await Promise.all(started.map((response) => readSse(response)));
        stack.anthropic.replies.length = 0;
        const used = await usageOf(user);
        expect(used.inputTokens + used.outputTokens).toBeLessThanOrEqual(1200);
        expect(used.reserved).toBe(0);
      }
    } finally {
      stack.anthropic.delayMs = 0;
    }
    const used = await usageOf(user);
    expect(used.inputTokens + used.outputTokens).toBeGreaterThan(800);
  });
});

describe('the token limit of a run', () => {
  let stack: TestStack;
  beforeAll(async () => {
    stack = await startStack({ AGENT_RUN_TOKEN_LIMIT: '300', AGENT_MAX_OUTPUT_TOKENS: '100' });
  });
  afterAll(() => stack.close());

  it('ends the run as incomplete before a step that could pass it', async () => {
    const user = stack.signUp();
    const thread = await user.createThread();
    const before = stack.anthropic.requests.length;
    stack.reply({ tool: { name: 'listNotes', input: {} } }, { text: 'Never sent.' });
    const events = await user.say(thread.id, 'What notes do I have?');
    stack.anthropic.replies.length = 0;
    expect(eventsOf(events, 'done')[0]).toMatchObject({
      status: 'incomplete',
      reason: 'token_limit',
      usage: { inputTokens: 100, outputTokens: 20 },
    });
    expect(stack.anthropic.requests.length).toBe(before + 1);
    const [row] = await stack.db.select().from(runs).where(eq(runs.threadId, thread.id));
    expect(row).toMatchObject({ status: 'incomplete', stopReason: 'token_limit' });
  });
});

describe('concurrent runs per user', () => {
  let stack: TestStack;
  beforeAll(async () => {
    stack = await startStack({ AGENT_MAX_CONCURRENT_RUNS: '2' });
  });
  afterAll(() => stack.close());

  it('refuses a run past the limit with 429 and Retry-After', async () => {
    const user = stack.signUp();
    const threads = await Promise.all([1, 2, 3].map(() => user.createThread()));
    stack.anthropic.delayMs = 300;
    try {
      const first = await Promise.all(threads.slice(0, 2).map((t) => send(user, t.id, 'hi')));
      const third = await send(user, threads[2]?.id as string, 'hi');
      expect(third.status).toBe(429);
      expect((await json(third)).type).toBe('urn:problem:too-many-runs');
      expect(third.headers.get('retry-after')).toBe('5');
      await Promise.all(first.map((response) => readSse(response)));
    } finally {
      stack.anthropic.delayMs = 0;
    }
    const again = await user.say(threads[2]?.id as string, 'hi');
    expect(eventsOf(again, 'done')[0].status).toBe('completed');
  });
});
