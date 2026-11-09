import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runs } from '../../src/db/schema.ts';
import { startStack, type TestStack } from '../helpers.ts';

let stack: TestStack;
beforeAll(async () => {
  stack = await startStack();
});
afterAll(() => stack.close());

describe('threads', () => {
  it('creates a thread with a Location header', async () => {
    const user = stack.signUp();
    const response = await user.request('/v1/threads', {
      method: 'POST',
      json: { title: ' Plans ' },
    });
    expect(response.status).toBe(201);
    const thread = await response.json();
    expect(thread).toMatchObject({ title: 'Plans' });
    expect(thread.id).toMatch(/^thr_[0-9a-f]{32}$/);
    expect(response.headers.get('location')).toBe(`/v1/threads/${thread.id}`);
  });

  it('creates an untitled thread', async () => {
    const user = stack.signUp();
    expect((await user.createThread()) as unknown).toMatchObject({ title: null });
  });

  it.each([
    ['an unknown field', { title: 'x', userId: 'usr_1' }, 'userId'],
    ['a blank title', { title: '  ' }, 'title'],
    ['a long title', { title: 'x'.repeat(201) }, 'title'],
  ])('rejects %s', async (_label, json, field) => {
    const user = stack.signUp();
    const response = await user.request('/v1/threads', { method: 'POST', json });
    expect(response.status).toBe(400);
    const problem = await response.json();
    expect(problem.type).toBe('urn:problem:validation-failed');
    expect(JSON.stringify(problem.errors)).toContain(field);
  });

  it('rejects a body that isn’t JSON', async () => {
    const user = stack.signUp();
    const wrongType = await user.request('/v1/threads', { method: 'POST', body: 'title=x' });
    expect(wrongType.status).toBe(415);
    const broken = await user.request('/v1/threads', {
      method: 'POST',
      body: '{',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(broken.status).toBe(400);
  });

  it('lists only the caller’s threads, a page at a time', async () => {
    const user = stack.signUp();
    const other = stack.signUp();
    await other.createThread('Not mine');
    for (const title of ['A', 'B', 'C']) await user.createThread(title);

    const first = await (await user.request('/v1/threads?limit=2')).json();
    expect(first.data).toHaveLength(2);
    expect(first.meta).toEqual({ limit: 2, nextCursor: '1' });
    const second = await (
      await user.request(`/v1/threads?limit=2&cursor=${first.meta.nextCursor}`)
    ).json();
    expect(second.meta.nextCursor).toBeNull();
    const titles = [...first.data, ...second.data].map((thread: { title: string }) => thread.title);
    expect(titles.sort()).toEqual(['A', 'B', 'C']);
  });

  it.each(['limit=0', 'limit=101', 'cursor=abc', 'cursor=0'])('rejects ?%s', async (params) => {
    const user = stack.signUp();
    const response = await user.request(`/v1/threads?${params}`);
    expect(response.status).toBe(400);
  });

  it('returns a thread with its messages', async () => {
    const user = stack.signUp();
    const thread = await user.createThread();
    stack.reply({ tool: { name: 'listNotes', input: {} } }, { text: 'No notes yet.' });
    await user.say(thread.id, 'List my notes');
    const body = await (await user.request(`/v1/threads/${thread.id}`)).json();
    expect(body.messages.map((message: { role: string }) => message.role)).toEqual([
      'user',
      'assistant',
    ]);
    expect(body.messages[0].text).toBe('List my notes');
    expect(body.messages[1].text).toBe('No notes yet.');
    expect(body.messages[1].toolCalls[0]).toMatchObject({
      toolName: 'listNotes',
      result: { notes: [], nextCursor: null },
    });
  });

  it('deletes a thread and its messages', async () => {
    const user = stack.signUp();
    const thread = await user.createThread();
    expect((await user.request(`/v1/threads/${thread.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await user.request(`/v1/threads/${thread.id}`)).status).toBe(404);
  });

  it('hides another user’s thread everywhere', async () => {
    const owner = stack.signUp();
    const intruder = stack.signUp();
    const thread = await owner.createThread('Private');
    for (const [method, json] of [
      ['GET', undefined],
      ['DELETE', undefined],
      ['POST', { content: 'hi' }],
    ] as const) {
      const path =
        method === 'POST' ? `/v1/threads/${thread.id}/messages` : `/v1/threads/${thread.id}`;
      const response = await intruder.request(path, { method, ...(json ? { json } : {}) });
      expect(response.status).toBe(404);
    }
    expect((await owner.request(`/v1/threads/${thread.id}`)).status).toBe(200);
  });

  it.each(['thr_00000000000000000000000000000000', 'junk'])('returns 404 for %s', async (id) => {
    const user = stack.signUp();
    expect((await user.request(`/v1/threads/${id}`)).status).toBe(404);
  });

  it.each([
    ['an empty message', ''],
    ['a long message', 'x'.repeat(8001)],
  ])('rejects %s', async (_label, content) => {
    const user = stack.signUp();
    const thread = await user.createThread();
    const response = await user.request(`/v1/threads/${thread.id}/messages`, {
      method: 'POST',
      json: { content },
    });
    expect(response.status).toBe(400);
  });

  it('answers one message at a time per thread', async () => {
    const user = stack.signUp();
    const thread = await user.createThread();
    const responses = await Promise.all(
      [1, 2].map(() =>
        user.request(`/v1/threads/${thread.id}/messages`, {
          method: 'POST',
          json: { content: 'hi' },
        }),
      ),
    );
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    await Promise.all(responses.map((response) => response.text()));
  });

  it('refuses to delete a thread while it’s answering', async () => {
    const user = stack.signUp();
    const thread = await user.createThread();
    await stack.db.insert(runs).values({ userId: user.id, threadId: thread.id });
    const response = await user.request(`/v1/threads/${thread.id}`, { method: 'DELETE' });
    expect(response.status).toBe(409);
    expect((await response.json()).type).toBe('urn:problem:thread-busy');
  });

  it('frees a thread whose run outlived the timeout', async () => {
    const user = stack.signUp();
    const thread = await user.createThread();
    await stack.db.insert(runs).values({
      userId: user.id,
      threadId: thread.id,
      updatedAt: new Date(Date.now() - 3_600_000),
    });
    const events = await user.say(thread.id, 'hi');
    expect(events.at(-1)?.data).toMatchObject({ status: 'completed' });
  });
});
