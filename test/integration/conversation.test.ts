import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runs } from '../../src/db/schema.ts';
import { fakeSignature } from '../fake-anthropic.ts';
import { eventsOf, readSse, runUsage, startStack, type TestStack, tokens } from '../helpers.ts';

let stack: TestStack;
beforeAll(async () => {
  stack = await startStack();
});
afterAll(() => stack.close());

describe('a conversation', () => {
  it('streams a reply that uses a tool, then remembers it on the next turn', async () => {
    const user = stack.signUp();
    stack.notesApi.notes.set(user.id, [
      {
        id: 'note_9',
        title: 'Groceries',
        body: 'eggs, milk',
        version: 1,
        createdAt: 'x',
        updatedAt: 'x',
      },
    ]);
    const thread = await user.createThread('Shopping');
    stack.reply(
      { tool: { name: 'listNotes', input: { limit: 5 } }, thinking: true },
      { text: 'You have one note: Groceries.' },
      { text: 'It says eggs and milk.' },
    );

    const first = await user.say(thread.id, 'What notes do I have?');
    expect(first.map((event) => event.event)).toEqual([
      'run',
      'tool-call',
      'tool-result',
      'text',
      'done',
    ]);
    expect(eventsOf(first, 'tool-result')[0].result.notes[0]).toMatchObject({ title: 'Groceries' });
    expect(eventsOf(first, 'done')[0]).toMatchObject({
      status: 'completed',
      reason: null,
      usage: runUsage(tokens(200, 40)),
    });

    await user.say(thread.id, 'What does it say?');
    const replay = JSON.stringify(stack.anthropic.requests.at(-1)?.messages);
    expect(replay).toContain('What notes do I have?');
    expect(replay).toContain('You have one note: Groceries.');
    expect(replay).toContain(fakeSignature);
  });

  it('sends the configured model and never sends sampling settings or forced tools', async () => {
    const user = stack.signUp();
    const thread = await user.createThread();
    await user.say(thread.id, 'Hi');
    const request = stack.anthropic.requests.at(-1);
    expect(request).toMatchObject({ model: 'claude-sonnet-5-5', max_tokens: 16_000 });
    expect(request).not.toHaveProperty('temperature');
    expect(request).not.toHaveProperty('top_p');
    expect(request).not.toHaveProperty('top_k');
    expect((request?.tool_choice as { type?: string } | undefined)?.type ?? 'auto').toBe('auto');
  });

  it('passes the caller’s own token to the notes API', async () => {
    const user = stack.signUp();
    const thread = await user.createThread();
    stack.reply(
      { tool: { name: 'createNote', input: { title: 'Idea', body: 'x' } } },
      { text: 'Saved.' },
    );
    await user.say(thread.id, 'Save an idea');
    expect(stack.notesApi.notes.get(user.id)?.map((note) => note.title)).toEqual(['Idea']);
    const create = stack.notesApi.requests.findLast((request) => request.method === 'POST');
    expect(create?.headers.get('authorization')).toBe(`Bearer ${user.token}`);
  });

  it('sends a keepalive comment while the model is slow, so proxies keep the stream open', async () => {
    const user = stack.signUp();
    const thread = await user.createThread();
    const before = stack.anthropic.requests.length;
    stack.anthropic.delayMs = 500;
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const response = user.request(`/v1/threads/${thread.id}/messages`, {
        method: 'POST',
        json: { content: 'hi' },
      });
      await vi.waitFor(() => expect(stack.anthropic.requests.length).toBeGreaterThan(before));
      vi.advanceTimersByTime(10_000);
      expect(await (await response).text()).toMatch(/^: keepalive$/m);
    } finally {
      vi.useRealTimers();
      stack.anthropic.delayMs = 0;
    }
  });

  it('counts each model call once when the client reads the stream late', async () => {
    const user = stack.signUp();
    const thread = await user.createThread();
    const before = stack.anthropic.requests.length;
    stack.reply({ tool: { name: 'listNotes', input: { limit: 5 } } }, { text: 'No notes yet.' });
    const response = await user.request(`/v1/threads/${thread.id}/messages`, {
      method: 'POST',
      json: { content: 'What notes do I have?' },
    });
    const untilSaved = { timeout: 5000 };
    await vi.waitFor(() => expect(stack.anthropic.requests.length).toBe(before + 2), untilSaved);
    await vi.waitFor(async () => {
      const saved = await (await user.request(`/v1/threads/${thread.id}`)).json();
      expect(JSON.stringify(saved.messages)).toContain('No notes yet.');
    }, untilSaved);

    const usage = runUsage(tokens(200, 40));
    expect(eventsOf(await readSse(response), 'done')[0].usage).toEqual(usage);
    expect(await (await user.request('/v1/usage')).json()).toMatchObject(usage);
  });

  it('frees the thread when the client disconnects mid-answer', async () => {
    const user = stack.signUp();
    const thread = await user.createThread();
    const before = stack.anthropic.requests.length;
    stack.anthropic.delayMs = 5000;
    const response = await user.request(`/v1/threads/${thread.id}/messages`, {
      method: 'POST',
      json: { content: 'hi' },
    });
    await vi.waitFor(() => expect(stack.anthropic.requests.length).toBeGreaterThan(before));
    await response.body?.cancel();
    stack.anthropic.delayMs = 0;

    await vi.waitFor(async () => {
      const rows = await stack.db.select().from(runs).where(eq(runs.threadId, thread.id));
      expect(rows.map((row) => row.status)).toEqual(['failed']);
    });
    expect(eventsOf(await user.say(thread.id, 'Still there?'), 'done')[0].status).toBe('completed');
  });
});
