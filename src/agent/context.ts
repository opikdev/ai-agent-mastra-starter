import type { NotesClient } from '../notes/client.ts';

/** What every agent call carries. The HTTP layer builds it from the caller's token. */
export interface AgentContext {
  userId: string;
  notes: NotesClient;
}
