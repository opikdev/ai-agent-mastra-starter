import type { ChunkType } from '@mastra/core/stream';
import type { PendingApproval, StopReason } from '../db/schema.ts';
import type { Usage } from './budget.ts';

export type RelayEvent =
  | { event: 'text'; data: { delta: string } }
  | { event: 'tool-call'; data: { toolCallId: string; toolName: string; args: unknown } }
  | { event: 'tool-result'; data: { toolCallId: string; toolName: string; result: unknown } }
  | { event: 'tool-error'; data: { toolCallId: string; toolName: string; detail: string } }
  | { event: 'blocked'; data: { reason: string } };

export type RelayStatus =
  | 'completed'
  | 'incomplete'
  | 'refused'
  | 'awaiting_approval'
  | 'blocked'
  | 'failed'
  | 'aborted';

/** How the model said its last step ended: the AI SDK's reason and the provider's own. */
export interface FinishReason {
  reason: string;
  raw: string | undefined;
}

export interface RelayResult {
  status: RelayStatus;
  pending?: PendingApproval;
  error?: unknown;
  /** The guardrail's reason, for a blocked message. */
  blockReason?: string;
  finish?: FinishReason;
}

interface RelayOptions {
  send: (event: RelayEvent) => Promise<void>;
  record: (usage: Usage) => Promise<void>;
  onToolError: (error: unknown) => void;
}

interface StepUsage {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  cachedInputTokens?: number | undefined;
  cacheCreationInputTokens?: number | undefined;
}

/** A Mastra step's usage. Its input total already includes the cached tokens. */
export function stepUsageOf(usage: StepUsage | undefined): Usage {
  return {
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    cacheReadInputTokens: usage?.cachedInputTokens ?? 0,
    cacheWriteInputTokens: usage?.cacheCreationInputTokens ?? 0,
  };
}

/**
 * Records the tokens of each finished model step. Pass it to Mastra as `onStepFinish`, which runs
 * as each step ends. The stream's step-finish chunk can't be used: when the run finishes, Mastra
 * overwrites the last step's usage on it with the run's total, often before the relay reads it.
 *
 * A step that pauses for approval reports its usage on the approval chunk instead. A resumed run
 * repeats that step first, so its usage is skipped there.
 */
export function stepUsage(
  record: (usage: Usage) => Promise<void>,
  { resumed }: { resumed: boolean },
) {
  let skipNext = resumed;
  return async (step: { usage?: StepUsage }) => {
    if (skipNext) skipNext = false;
    else await record(stepUsageOf(step.usage));
  };
}

export interface Outcome {
  status: RelayStatus;
  reason: StopReason | null;
}

/**
 * Turns how the stream ended into the run's status. A reply the model stopped at its output cap
 * is `incomplete`, and one it declined is `refused`, never `completed`. A run that ends on a tool
 * call, without pausing for approval, ran out of steps or of tokens.
 */
export function outcomeOf(result: RelayResult, { tokenLimitReached = false } = {}): Outcome {
  if (result.status !== 'completed') return { status: result.status, reason: null };
  switch (result.finish?.reason) {
    case 'length':
      return {
        status: 'incomplete',
        reason:
          result.finish.raw === 'model_context_window_exceeded' ? 'context_window' : 'max_tokens',
      };
    case 'content-filter':
      return { status: 'refused', reason: 'refusal' };
    case 'tool-calls':
      return { status: 'incomplete', reason: tokenLimitReached ? 'token_limit' : 'max_steps' };
    default:
      return { status: 'completed', reason: null };
  }
}

/**
 * Forwards an agent stream as client events, and records the usage of a step that pauses for
 * approval.
 *
 * A pending approval is returned, not sent, because the caller must save it before the client
 * can approve it. A guardrail block is returned too, because the caller decides whether it was a
 * verdict or a failed check.
 */
export async function relay(
  chunks: AsyncIterable<ChunkType<undefined>>,
  { send, record, onToolError }: RelayOptions,
): Promise<RelayResult> {
  let result: RelayResult = { status: 'completed' };

  for await (const chunk of chunks) {
    switch (chunk.type) {
      case 'text-delta':
        await send({ event: 'text', data: { delta: chunk.payload.text } });
        break;
      case 'tool-call':
        await send({
          event: 'tool-call',
          data: {
            toolCallId: chunk.payload.toolCallId,
            toolName: chunk.payload.toolName,
            args: chunk.payload.args,
          },
        });
        break;
      case 'tool-result':
        await send({
          event: 'tool-result',
          data: {
            toolCallId: chunk.payload.toolCallId,
            toolName: chunk.payload.toolName,
            result: chunk.payload.result,
          },
        });
        break;
      case 'tool-error':
        onToolError(chunk.payload.error);
        await send({
          event: 'tool-error',
          data: {
            toolCallId: chunk.payload.toolCallId,
            toolName: chunk.payload.toolName,
            detail: 'The tool failed. The agent was told, and may try another way.',
          },
        });
        break;
      case 'tool-call-approval': {
        const pending = {
          toolCallId: chunk.payload.toolCallId,
          toolName: chunk.payload.toolName,
          args: chunk.payload.args,
        };
        await record(stepUsageOf(chunk.payload.usage));
        result = { status: 'awaiting_approval', pending };
        break;
      }
      case 'finish':
        result.finish = {
          reason: String(chunk.payload.stepResult.reason),
          raw: (chunk.payload.stepResult as { rawReason?: string }).rawReason,
        };
        break;
      case 'tripwire':
        result = { status: 'blocked', blockReason: chunk.payload.reason };
        break;
      case 'abort':
        result = { status: 'aborted' };
        break;
      case 'error':
        result = { status: 'failed', error: chunk.payload.error };
        break;
    }
  }
  return result;
}
