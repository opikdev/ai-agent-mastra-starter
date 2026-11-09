import { RequestContext } from '@mastra/core/request-context';
import { describe, expect, it } from 'vitest';
import { cases } from '../../evals/cases.ts';
import { createNotesAssistant } from '../../src/agent/notes-assistant.ts';
import { listNotes, notesTools } from '../../src/agent/tools.ts';
import type { NotesClient } from '../../src/notes/client.ts';

function context(notes?: Partial<NotesClient>) {
  const requestContext = new RequestContext();
  requestContext.set('userId', 'usr_1');
  if (notes) requestContext.set('notes', notes);
  return { requestContext } as never;
}

describe('notes tools', () => {
  it('needs approval for exactly the tools that change or delete notes', () => {
    const gated = Object.entries(notesTools)
      .filter(([, tool]) => tool.requireApproval === true)
      .map(([name]) => name);
    expect(gated.sort()).toEqual(['deleteNote', 'updateNote']);
  });

  it('has an eval case that calls each tool needing approval', () => {
    const called = cases.flatMap((testCase) =>
      testCase.gates
        .filter((gate) => gate.id === 'check-called-tool')
        .map((gate) => gate.description),
    );
    for (const [name, tool] of Object.entries(notesTools)) {
      if (tool.requireApproval !== true) continue;
      expect(called, name).toContain(`Checks that "${name}" was called`);
    }
  });

  it('trims long bodies to a preview when listing', async () => {
    const notes = {
      list: async () => ({
        data: [
          { id: 'note_1', title: 'Long', body: 'x'.repeat(500), createdAt: 'x', updatedAt: 'y' },
        ],
        meta: { nextCursor: null },
      }),
    };
    const result = await listNotes.execute?.({ limit: 5 }, context(notes));
    expect(result).toEqual({
      notes: [{ id: 'note_1', title: 'Long', preview: 'x'.repeat(200), updatedAt: 'y' }],
      nextCursor: null,
    });
  });

  it('refuses to run without the caller’s notes client', async () => {
    const result = await listNotes.execute?.({ limit: 5 }, context());
    expect(result).toMatchObject({ error: true });
    expect(JSON.stringify(result)).toContain('notes client');
  });

  it('stops the agent before any model call when the context is missing', async () => {
    const agent = createNotesAssistant({
      model: 'anthropic/claude-sonnet-5-5',
      guardrailModel: 'off',
      memoryMessages: 5,
    });
    await expect(agent.stream('hi')).rejects.toThrow('notes client');
  });

  it('lets bugs throw instead of hiding them from the logs', async () => {
    const notes = {
      list: async () => {
        throw new TypeError('bug');
      },
    };
    await expect(listNotes.execute?.({ limit: 5 }, context(notes))).rejects.toThrow('bug');
  });
});
