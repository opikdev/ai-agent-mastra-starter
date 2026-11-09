import { RequestContext } from '@mastra/core/request-context';
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

export interface RunLimits {
  maxSteps: number;
  maxOutputTokens: number;
}

interface RunOptionsInput {
  context: AgentContext;
  threadId: string;
  limits: RunLimits;
  abortSignal?: AbortSignal;
}

/** Options for every agent call, from the API and the evals alike. */
export function runOptions({ context, threadId, limits, abortSignal }: RunOptionsInput) {
  const requestContext = new RequestContext<AgentContext>();
  requestContext.set('userId', context.userId);
  requestContext.set('notes', context.notes);
  return {
    memory: { thread: threadId, resource: context.userId },
    requestContext,
    maxSteps: limits.maxSteps,
    modelSettings: { maxOutputTokens: limits.maxOutputTokens },
    ...(abortSignal ? { abortSignal } : {}),
  };
}
