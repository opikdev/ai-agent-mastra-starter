import { RequestContext } from '@mastra/core/request-context';
import { z } from 'zod';
import type { NotesClient } from '../notes/client.ts';
import type { Usage } from './budget.ts';

/** What every agent call carries. The HTTP layer builds it from the caller's token. */
export const agentContextSchema = z.object({
  userId: z.string().min(1),
  notes: z.custom<NotesClient>(
    (value) => typeof value === 'object' && value !== null,
    'must be the caller’s notes client',
  ),
});

export type AgentContext = z.infer<typeof agentContextSchema>;

/** Takes a model call's tokens. It must not throw, because a failing guardrail lets messages through. */
export type UsageRecorder = (usage: Usage) => void;

/** The request context key for the recorder of the guardrail's tokens. */
export const guardrailUsageKey = 'recordGuardrailUsage';

type RunContext = AgentContext & { [guardrailUsageKey]?: UsageRecorder };

export interface RunLimits {
  maxSteps: number;
  maxOutputTokens: number;
}

interface RunOptionsInput {
  context: AgentContext;
  threadId: string;
  limits: RunLimits;
  abortSignal?: AbortSignal;
  recordGuardrailUsage?: UsageRecorder;
}

/** Options for every agent call, from the API and the evals alike. */
export function runOptions({
  context,
  threadId,
  limits,
  abortSignal,
  recordGuardrailUsage,
}: RunOptionsInput) {
  const requestContext = new RequestContext<RunContext>();
  requestContext.set('userId', context.userId);
  requestContext.set('notes', context.notes);
  if (recordGuardrailUsage) requestContext.set(guardrailUsageKey, recordGuardrailUsage);
  return {
    memory: { thread: threadId, resource: context.userId },
    requestContext,
    maxSteps: limits.maxSteps,
    modelSettings: { maxOutputTokens: limits.maxOutputTokens },
    ...(abortSignal ? { abortSignal } : {}),
  };
}
