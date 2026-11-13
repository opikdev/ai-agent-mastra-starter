import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { idempotencyKeys, runs } from '../../src/db/schema.ts';
import { eventsOf, json, readSse, startStack, type TestStack, tokens } from '../helpers.ts';

let stack: TestStack;
beforeAll(async () => {
  stack = await startStack({ AGENT_MAX_STEPS: '2' });
});
afterAll(() => stack.close());

async function statusOf(threadId: string) {
  const [row] = await stack.db.select().from(runs).where(eq(runs.threadId, threadId));
  return { status: row?.status, stopReason: row?.stopReason };
}

describe('how a run ends', () => {
  it.each([
    ['max_tokens', 'incomplete', 'max_tokens'],
    ['refusal', 'refused', 'refusal'],
  ] as const)('reports a %s stop as %s, not completed', async (stopReason, status, reason) => {
    const user = stack.signUp();
    const thread = await user.createThread();
    stack.reply({ text: 'Partial', stopReason });
    const events = await user.say(thread.id, 'Write a lot');
    expect(eventsOf(events, 'done')[0]).toMatchObject({ status, reason });
    expect(await statusOf(thread.id)).toEqual({ status, stopReason: reason });
  });

  it('reports a run that runs out of steps as incomplete', async () => {
    const user = stack.signUp();
    const thread = await user.createThread();
    stack.reply(
      { tool: { name: 'listNotes', input: {} } },
      { tool: { name: 'listNotes', input: {} } },
    );
    const events = await user.say(thread.id, 'Keep looking');
    expect(eventsOf(events, 'done')[0]).toMatchObject({
      status: 'incomplete',
      reason: 'max_steps',
    });
    expect(await statusOf(thread.id)).toEqual({ status: 'incomplete', stopReason: 'max_steps' });
  });

  it('reports a full answer as completed, with no reason', async () => {
    const user = stack.signUp();
    const thread = await user.createThread();
    const events = await user.say(thread.id, 'Hi');
    expect(eventsOf(events, 'done')[0]).toMatchObject({ status: 'completed', reason: null });
    expect(await statusOf(thread.id)).toEqual({ status: 'completed', stopReason: null });
  });
});

describe('prompt caching', () => {
  it('marks the instructions and the moving prompt prefix for caching', async () => {
    const user = stack.signUp();
    const thread = await user.createThread();
    await user.say(thread.id, 'Hi');
    const request = stack.anthropic.requests.at(-1) as Record<string, unknown>;
    expect(request.cache_control).toEqual({ type: 'ephemeral' });
    const system = request.system as Array<Record<string, unknown>>;
    expect(system.at(-1)?.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('records the tokens read from and written to the cache', async () => {
    const user = stack.signUp();
    const thread = await user.createThread();
    stack.anthropic.usage = { input: 100, output: 20, cacheRead: 50, cacheWrite: 30 };
    try {
      const events = await user.say(thread.id, 'Hi');
      const cached = tokens(180, 20, 50, 30);
      expect(eventsOf(events, 'done')[0].usage).toMatchObject({ ...cached, agent: cached });
      expect(await (await user.request('/v1/usage')).json()).toMatchObject(cached);
    } finally {
      stack.anthropic.usage = { input: 100, output: 20 };
    }
  });
});

describe('Idempotency-Key', () => {
  function send(
    user: ReturnType<TestStack['signUp']>,
    threadId: string,
    content: string,
    key: string,
  ) {
    return user.request(`/v1/threads/${threadId}/messages`, {
      method: 'POST',
      json: { content },
      headers: { 'Idempotency-Key': key },
    });
  }

  it('answers a retry with the run the first request started, without sending it again', async () => {
    const user = stack.signUp();
    const thread = await user.createThread();
    const first = await readSse(await send(user, thread.id, 'Hi', 'key-1'));
    const { runId } = eventsOf(first, 'run')[0];
    const before = stack.anthropic.requests.length;

    const retry = await send(user, thread.id, 'Hi', 'key-1');
    expect(retry.status).toBe(409);
    expect(await json(retry)).toMatchObject({
      type: 'urn:problem:duplicate-request',
      runId,
      runStatus: 'completed',
    });
    expect(stack.anthropic.requests.length).toBe(before);
  });

  it('frees the key of a run that failed before any tool ran, so the retry runs', async () => {
    const user = stack.signUp();
    const thread = await user.createThread();
    stack.reply({ status: 400, error: 'invalid request' });
    const first = await readSse(await send(user, thread.id, 'Hi', 'key-5'));
    expect(eventsOf(first, 'done')[0]).toMatchObject({ status: 'failed', reason: 'model_error' });

    const retry = await send(user, thread.id, 'Hi', 'key-5');
    expect(retry.status).toBe(200);
    expect(eventsOf(await readSse(retry), 'done')[0].status).toBe('completed');
  });

  it('keeps the key of a run that failed after a tool ran, and says it failed', async () => {
    const user = stack.signUp();
    const thread = await user.createThread();
    stack.reply(
      { tool: { name: 'listNotes', input: {} } },
      { status: 400, error: 'invalid request' },
    );
    const first = await readSse(await send(user, thread.id, 'Hi', 'key-6'));
    expect(eventsOf(first, 'tool-result')).toHaveLength(1);
    expect(eventsOf(first, 'done')[0]).toMatchObject({ status: 'failed', reason: 'model_error' });
    const before = stack.anthropic.requests.length;

    const retry = await send(user, thread.id, 'Hi', 'key-6');
    expect(retry.status).toBe(409);
    const problem = await json(retry);
    expect(problem).toMatchObject({
      type: 'urn:problem:duplicate-request',
      runId: eventsOf(first, 'run')[0].runId,
      runStatus: 'failed',
    });
    expect(problem.detail).toContain('new key');
    expect(stack.anthropic.requests.length).toBe(before);
  });

  it('rejects the key for a different message or thread', async () => {
    const user = stack.signUp();
    const [thread, other] = [await user.createThread(), await user.createThread()];
    await readSse(await send(user, thread.id, 'Hi', 'key-2'));
    for (const response of [
      await send(user, thread.id, 'Something else', 'key-2'),
      await send(user, other.id, 'Hi', 'key-2'),
    ]) {
      expect(response.status).toBe(422);
      expect((await json(response)).type).toBe('urn:problem:idempotency-key-reused');
    }
  });

  it('keeps a key free when the request it came with was refused', async () => {
    const user = stack.signUp();
    const thread = await user.createThread();
    stack.anthropic.delayMs = 300;
    try {
      const busy = await user.request(`/v1/threads/${thread.id}/messages`, {
        method: 'POST',
        json: { content: 'first' },
      });
      const refused = await send(user, thread.id, 'Hi', 'key-3');
      expect(refused.status).toBe(409);
      expect((await json(refused)).type).toBe('urn:problem:thread-busy');
      await readSse(busy);
    } finally {
      stack.anthropic.delayMs = 0;
    }
    expect((await send(user, thread.id, 'Hi', 'key-3')).status).toBe(200);
  });

  it('treats an expired key as new', async () => {
    const user = stack.signUp();
    const thread = await user.createThread();
    await readSse(await send(user, thread.id, 'Hi', 'key-4'));
    await stack.db
      .update(idempotencyKeys)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(idempotencyKeys.userId, user.id));
    const again = await send(user, thread.id, 'Different', 'key-4');
    expect(again.status).toBe(200);
    expect(eventsOf(await readSse(again), 'done')[0].status).toBe('completed');
  });
});
