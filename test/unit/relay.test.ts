import type { ChunkType } from '@mastra/core/stream';
import { describe, expect, it } from 'vitest';
import type { Usage } from '../../src/agent/budget.ts';
import { type RelayEvent, relay } from '../../src/agent/relay.ts';

async function* from(chunks: unknown[]) {
  for (const chunk of chunks) yield chunk as ChunkType<undefined>;
}

async function run(chunks: unknown[]) {
  const events: RelayEvent[] = [];
  const usage: Usage[] = [];
  const toolErrors: unknown[] = [];
  const result = await relay(from(chunks), {
    send: async (event) => {
      events.push(event);
    },
    record: async (spent) => {
      usage.push(spent);
    },
    onToolError: (error) => toolErrors.push(error),
  });
  return { result, events, usage, toolErrors };
}

const step = (inputTokens: number) => ({
  type: 'step-finish',
  payload: { output: { usage: { inputTokens, outputTokens: 1 } } },
});

describe('relay', () => {
  it('reports a tool failure without its details and keeps going', async () => {
    const boom = new Error('secret detail');
    const { result, events, toolErrors } = await run([
      { type: 'tool-error', payload: { toolCallId: 't1', toolName: 'getNote', error: boom } },
    ]);
    expect(result.status).toBe('completed');
    expect(toolErrors).toEqual([boom]);
    expect(JSON.stringify(events)).not.toContain('secret detail');
  });

  it('returns a pending approval for the caller to save before it tells the client', async () => {
    const { result, events } = await run([
      {
        type: 'tool-call-approval',
        payload: { toolCallId: 't1', toolName: 'deleteNote', args: { id: 'n1' }, usage: {} },
      },
    ]);
    expect(result).toEqual({
      status: 'awaiting_approval',
      pending: { toolCallId: 't1', toolName: 'deleteNote', args: { id: 'n1' } },
    });
    expect(events).toEqual([]);
  });

  it('skips the repeated usage of a resumed step only', async () => {
    const { usage } = await run([{ type: 'tool-call-resumed', payload: {} }, step(5), step(7)]);
    expect(usage.map((spent) => spent.inputTokens)).toEqual([7]);
  });

  it('counts missing usage as zero', async () => {
    const { usage } = await run([{ type: 'step-finish', payload: { output: {} } }]);
    expect(usage).toEqual([{ inputTokens: 0, outputTokens: 0 }]);
  });

  it.each([
    ['abort', { type: 'abort', payload: {} }, 'aborted'],
    ['error', { type: 'error', payload: { error: new Error('x') } }, 'failed'],
    ['tripwire', { type: 'tripwire', payload: { reason: 'no' } }, 'blocked'],
  ])('ends as %s', async (_label, chunk, status) => {
    expect((await run([chunk])).result.status).toBe(status);
  });
});
