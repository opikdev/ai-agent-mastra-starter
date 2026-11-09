import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fakeSignature } from '../fake-anthropic.ts';
import { eventsOf, startStack, type TestStack } from '../helpers.ts';

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
      usage: { inputTokens: 200, outputTokens: 40 },
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
    expect(request).toMatchObject({ model: 'claude-sonnet-5-5', max_tokens: 4096 });
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
});
