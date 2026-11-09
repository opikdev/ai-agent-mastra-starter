import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
