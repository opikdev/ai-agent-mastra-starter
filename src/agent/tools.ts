import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { UpstreamError } from '../notes/client.ts';
import { agentContextSchema } from './context.ts';

const previewLength = 200;

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
  requestContextSchema: agentContextSchema,
  description:
    'Lists the user’s notes, newest first, with a preview of each body. Pass nextCursor from a result to get the next page.',
  inputSchema: z.object({
    limit: z.number().int().min(1).max(50).default(20).describe('Notes per page.'),
    cursor: z.string().max(100).optional().describe('nextCursor from a previous result.'),
  }),
  execute: async ({ limit, cursor }, { requestContext, abortSignal }) =>
    attempt(async () => {
      const page = await requestContext.get('notes').list({ limit, cursor }, abortSignal);
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
  requestContextSchema: agentContextSchema,
  description: 'Gets one note with its full body.',
  inputSchema: z.object({ id: noteId }),
  execute: async ({ id }, { requestContext, abortSignal }) =>
    attempt(() => requestContext.get('notes').get(id, abortSignal)),
});

export const createNote = createTool({
  id: 'create-note',
  requestContextSchema: agentContextSchema,
  description: 'Creates a note. Each call creates a new note, so call it once per note.',
  inputSchema: z.object({
    title: z.string().trim().min(1).max(200).describe('Short title.'),
    body: z.string().max(10_000).default('').describe('Note text.'),
  }),
  execute: async (input, { requestContext, abortSignal }) =>
    attempt(() => requestContext.get('notes').create(input, abortSignal)),
});

export const updateNote = createTool({
  id: 'update-note',
  requestContextSchema: agentContextSchema,
  description:
    'Changes a note’s title, body, or both. The user must approve the change before it runs.',
  inputSchema: z.object({
    id: noteId,
    title: z.string().trim().min(1).max(200).optional().describe('New title.'),
    body: z.string().max(10_000).optional().describe('New body. Replaces the whole body.'),
  }),
  requireApproval: true,
  execute: async ({ id, ...changes }, { requestContext, abortSignal }) =>
    attempt(() => requestContext.get('notes').update(id, changes, abortSignal)),
});

export const deleteNote = createTool({
  id: 'delete-note',
  requestContextSchema: agentContextSchema,
  description: 'Deletes a note for good. The user must approve it before it runs.',
  inputSchema: z.object({ id: noteId }),
  requireApproval: true,
  execute: async ({ id }, { requestContext, abortSignal }) =>
    attempt(async () => {
      await requestContext.get('notes').remove(id, abortSignal);
      return { deleted: id };
    }),
});

export const notesTools = { listNotes, getNote, createNote, updateNote, deleteNote };
