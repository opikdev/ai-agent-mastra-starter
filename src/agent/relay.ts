import type { ChunkType } from '@mastra/core/stream';
import type { PendingApproval } from '../db/schema.ts';
import type { Usage } from './budget.ts';

export type RelayEvent =
  | { event: 'text'; data: { delta: string } }
  | { event: 'tool-call'; data: { toolCallId: string; toolName: string; args: unknown } }
  | { event: 'tool-result'; data: { toolCallId: string; toolName: string; result: unknown } }
  | { event: 'tool-error'; data: { toolCallId: string; toolName: string; detail: string } }
  | { event: 'blocked'; data: { reason: string } };

export type RelayStatus = 'completed' | 'awaiting_approval' | 'blocked' | 'failed' | 'aborted';

export interface RelayResult {
  status: RelayStatus;
  pending?: PendingApproval;
  error?: unknown;
}

interface RelayOptions {
  send: (event: RelayEvent) => Promise<void>;
  record: (usage: Usage) => Promise<void>;
  onToolError: (error: unknown) => void;
}

function usageOf(
  usage: { inputTokens?: number | undefined; outputTokens?: number | undefined } | undefined,
): Usage {
  return { inputTokens: usage?.inputTokens ?? 0, outputTokens: usage?.outputTokens ?? 0 };
}

/**
 * Forwards an agent stream as client events and records the tokens of every model call.
 *
 * A pending approval is returned, not sent, because the caller must save it before the client
 * can approve it.
 *
 * A step that pauses for approval reports its usage on the approval chunk. When the run resumes,
 * Mastra repeats that step's usage on the next step-finish, so it's skipped there.
 */
export async function relay(
  chunks: AsyncIterable<ChunkType<undefined>>,
  { send, record, onToolError }: RelayOptions,
): Promise<RelayResult> {
  let result: RelayResult = { status: 'completed' };
  let skipNextStepUsage = false;

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
      case 'tool-call-resumed':
        skipNextStepUsage = true;
        break;
      case 'tool-call-approval': {
        const pending = {
          toolCallId: chunk.payload.toolCallId,
          toolName: chunk.payload.toolName,
          args: chunk.payload.args,
        };
        await record(usageOf(chunk.payload.usage));
        result = { status: 'awaiting_approval', pending };
        break;
      }
      case 'step-finish':
        if (skipNextStepUsage) skipNextStepUsage = false;
        else await record(usageOf(chunk.payload.output.usage));
        break;
      case 'tripwire':
        result = { status: 'blocked' };
        await send({ event: 'blocked', data: { reason: chunk.payload.reason } });
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
