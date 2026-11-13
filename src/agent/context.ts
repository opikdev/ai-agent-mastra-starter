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

/**
 * Hears about each guardrail model call in one run. Neither method may throw, because the
 * detector must see only the model's own errors.
 */
export interface GuardrailMonitor {
  record: (usage: Usage) => void;
  failed: (error: unknown) => void;
}

/** The request context key for the run's guardrail monitor. */
export const guardrailMonitorKey = 'guardrailMonitor';

type RunContext = AgentContext & { [guardrailMonitorKey]?: GuardrailMonitor };

export interface RunLimits {
  maxSteps: number;
  maxOutputTokens: number;
}

/** Whether spans may hold prompts, replies, and tool data, and which trace a run joins. */
export interface RunTracing {
  recordContent: boolean;
  traceId?: string | undefined;
  parentSpanId?: string | undefined;
}

/** The part of a finished step that a stop condition reads. */
export interface StepTokens {
  usage: { inputTokens?: number | undefined; outputTokens?: number | undefined };
}

export type StopCondition = (options: { steps: StepTokens[] }) => boolean;

interface RunOptionsInput {
  context: AgentContext;
  threadId: string;
  limits: RunLimits;
  tracing: RunTracing;
  abortSignal?: AbortSignal;
  guardrailMonitor?: GuardrailMonitor;
  /** Ends the run before a step that could spend more than the run may. */
  stopWhen?: StopCondition;
}

/**
 * Caches the prompt prefix with Anthropic's automatic caching: one breakpoint that moves to the
 * end of each request, so each step reads the tools, instructions, and conversation so far from
 * the cache. The system prompt carries its own breakpoint, in `notes-assistant.ts`.
 */
export const promptCaching = { anthropic: { cacheControl: { type: 'ephemeral' as const } } };

/** Options for every agent call, from the API and the evals alike. */
export function runOptions({
  context,
  threadId,
  limits,
  tracing,
  abortSignal,
  guardrailMonitor,
  stopWhen,
}: RunOptionsInput) {
  const requestContext = new RequestContext<RunContext>();
  requestContext.set('userId', context.userId);
  requestContext.set('notes', context.notes);
  if (guardrailMonitor) requestContext.set(guardrailMonitorKey, guardrailMonitor);
  return {
    memory: { thread: threadId, resource: context.userId },
    requestContext,
    maxSteps: limits.maxSteps,
    modelSettings: { maxOutputTokens: limits.maxOutputTokens },
    providerOptions: promptCaching,
    tracingOptions: {
      hideInput: !tracing.recordContent,
      hideOutput: !tracing.recordContent,
      ...(tracing.traceId && tracing.parentSpanId
        ? { traceId: tracing.traceId, parentSpanId: tracing.parentSpanId }
        : {}),
    },
    ...(stopWhen ? { stopWhen } : {}),
    ...(abortSignal ? { abortSignal } : {}),
  };
}
