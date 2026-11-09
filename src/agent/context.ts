import { z } from 'zod';
import type { NotesClient } from '../notes/client.ts';

/** What every agent call carries. The HTTP layer builds it from the caller's token. */
export const agentContextSchema = z.object({
  userId: z.string().min(1),
  notes: z.custom<NotesClient>(
    (value) => typeof value === 'object' && value !== null,
    'must be the caller’s notes client',
  ),
});

export type AgentContext = z.infer<typeof agentContextSchema>;
