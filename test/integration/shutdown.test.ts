import type { AddressInfo } from 'node:net';
import { type ServerType, serve } from '@hono/node-server';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runs } from '../../src/db/schema.ts';
import { onShutdown, type Readiness, shutdown } from '../../src/platform/shutdown.ts';
import { eventsOf, readSse, startStack, type TestStack, type TestUser } from '../helpers.ts';

function listen(app: { fetch: Hono['fetch'] }): Promise<{ server: ServerType; url: string }> {
  return new Promise((resolve) => {
    const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => {
      resolve({ server, url: `http://127.0.0.1:${(info as AddressInfo).port}` });
    });
  });
}

const noop = async () => {};

describe('shutdown', () => {
  it('drains first and keeps serving, then stops accepting connections', async () => {
    const readiness: Readiness = { draining: false };
    const app = new Hono().get('/', (c) => c.text(readiness.draining ? 'draining' : 'ready'));
    const { server, url } = await listen(app);

    const stopped = shutdown({
      server,
      readiness,
      drainMs: 300,
      timeoutMs: 1000,
      settleMs: 100,
      abortInFlight: () => {},
      close: noop,
    });
    expect(readiness.draining).toBe(true);
    expect(await (await fetch(url)).text()).toBe('draining');
    await stopped;
    await expect(fetch(url)).rejects.toThrow();
  });

  it('aborts what runs past the timeout, then closes, then runs final tasks', async () => {
    const steps: string[] = [];
    let release: () => void = () => {};
    let arrived: () => void = () => {};
    const requestArrived = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const app = new Hono().get('/hang', async (c) => {
      await new Promise<void>((resolve) => {
        release = resolve;
        arrived();
      });
      return c.text('aborted');
    });
    const { server, url } = await listen(app);
    onShutdown(async () => {
      steps.push('final task');
    });
    const hung = fetch(`${url}/hang`).then((response) => response.text());
    await requestArrived;

    const startedAt = performance.now();
    await shutdown({
      server,
      readiness: { draining: false },
      drainMs: 0,
      timeoutMs: 200,
      settleMs: 1000,
      abortInFlight: () => {
        steps.push('abort');
        release();
      },
      close: async () => {
        steps.push('close');
      },
    });
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(190);
    expect(await hung).toBe('aborted');
    expect(steps).toEqual(['abort', 'close', 'final task']);
  });
});

describe('a deploy during a run', () => {
  let stack: TestStack;
  let user: TestUser;
  let server: ServerType;
  let url: string;
  beforeAll(async () => {
    stack = await startStack();
    user = stack.signUp();
    ({ server, url } = await listen(stack.app));
  });
  afterAll(() => stack.close());

  function say(threadId: string) {
    return fetch(`${url}/v1/threads/${threadId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${user.token}`,
        'Content-Type': 'application/json',
        'X-Forwarded-For': '2001:db8::1',
      },
      body: JSON.stringify({ content: 'hi' }),
    }).then(readSse);
  }

  it('fails readiness while still serving requests', async () => {
    stack.readiness.draining = true;
    try {
      expect((await stack.app.request('/readyz')).status).toBe(503);
      expect((await stack.app.request('/healthz')).status).toBe(200);
      expect((await user.request('/v1/threads')).status).toBe(200);
    } finally {
      stack.readiness.draining = false;
    }
  });

  it('lets a run in flight finish, and aborts one that outlasts the timeout', async () => {
    const [quick, slow] = [await user.createThread(), await user.createThread()];
    const before = stack.anthropic.requests.length;
    stack.anthropic.delayMs = 400;
    const quickReply = say(quick.id);
    await vi.waitFor(() => expect(stack.anthropic.requests.length).toBe(before + 1));
    stack.anthropic.delayMs = 5000;
    const slowReply = say(slow.id);
    await vi.waitFor(() => expect(stack.anthropic.requests.length).toBe(before + 2));

    await shutdown({
      server,
      readiness: stack.readiness,
      drainMs: 0,
      timeoutMs: 1000,
      settleMs: 2000,
      abortInFlight: () => stack.shutdown.abort(),
      close: noop,
    });
    stack.anthropic.delayMs = 0;

    expect(eventsOf(await quickReply, 'done')[0]).toMatchObject({ status: 'completed' });
    const slowEvents = await slowReply;
    expect(eventsOf(slowEvents, 'error')[0].detail).toContain('shut down');
    expect(eventsOf(slowEvents, 'done')[0]).toMatchObject({
      status: 'aborted',
      reason: 'shutdown',
    });
    const [row] = await stack.db.select().from(runs).where(eq(runs.threadId, slow.id));
    expect(row).toMatchObject({ status: 'failed', stopReason: 'shutdown', reservedTokens: 0 });
  });
});
