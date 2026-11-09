import type { RequestContext } from '@mastra/core/request-context';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { type NotesClient, UpstreamError } from '../notes/client.ts';

/** What every agent call carries. The HTTP layer builds it from the caller's token. */
export interface AgentContext {
  userId: string;
  notes: NotesClient;
}

const previewLength = 200;

function notesFrom(context: { requestContext?: RequestContext<unknown> } | undefined): NotesClient {
  const notes = (context?.requestContext as RequestContext<AgentContext> | undefined)?.get('notes');
  if (!notes) throw new Error('The agent ran without a notes client in its request context.');
  return notes;
}

/** Upstream failures go back to the model as data, so it can explain or retry. Bugs still throw. */
async function attempt<T>(run: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof UpstreamError) return { error: error.message };
    throw error;
  }
}

const noteId = z.string().min(1).max(100).describe('The note ID, such as note_0190a7e4...');

export const listNotes = createTool({
  id: 'list-notes',
  description:
    'Lists the user’s notes, newest first, with a preview of each body. Pass nextCursor from a result to get the next page.',
  inputSchema: z.object({
    limit: z.number().int().min(1).max(50).default(20).describe('Notes per page.'),
    cursor: z.string().max(100).optional().describe('nextCursor from a previous result.'),
  }),
  execute: async ({ limit, cursor }, context) =>
    attempt(async () => {
      const page = await notesFrom(context).list({ limit, cursor });
      return {
        notes: page.data.map(({ id, title, body, updatedAt }) => ({
          id,
          title,
          preview: body.slice(0, previewLength),
          updatedAt,
        })),
        nextCursor: page.meta.nextCursor,
      };
    }),
});

export const getNote = createTool({
  id: 'get-note',
  description: 'Gets one note with its full body.',
  inputSchema: z.object({ id: noteId }),
  execute: async ({ id }, context) => attempt(() => notesFrom(context).get(id)),
});

export const createNote = createTool({
  id: 'create-note',
  description: 'Creates a note. Each call creates a new note, so call it once per note.',
  inputSchema: z.object({
    title: z.string().trim().min(1).max(200).describe('Short title.'),
    body: z.string().max(10_000).default('').describe('Note text.'),
  }),
  execute: async (input, context) => attempt(() => notesFrom(context).create(input)),
});

export const updateNote = createTool({
  id: 'update-note',
  description:
    'Changes a note’s title, body, or both. The user must approve the change before it runs.',
  inputSchema: z.object({
    id: noteId,
    title: z.string().trim().min(1).max(200).optional().describe('New title.'),
    body: z.string().max(10_000).optional().describe('New body. Replaces the whole body.'),
  }),
  requireApproval: true,
  execute: async ({ id, ...changes }, context) =>
    attempt(() => notesFrom(context).update(id, changes)),
});

export const deleteNote = createTool({
  id: 'delete-note',
  description: 'Deletes a note for good. The user must approve it before it runs.',
  inputSchema: z.object({ id: noteId }),
  requireApproval: true,
  execute: async ({ id }, context) =>
    attempt(async () => {
      await notesFrom(context).remove(id);
      return { deleted: id };
    }),
});

export const notesTools = { listNotes, getNote, createNote, updateNote, deleteNote };
