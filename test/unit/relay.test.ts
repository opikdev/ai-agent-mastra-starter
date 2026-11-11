import type { ChunkType } from '@mastra/core/stream';
import { describe, expect, it } from 'vitest';
import type { Usage } from '../../src/agent/budget.ts';
import { type RelayEvent, relay, stepUsage } from '../../src/agent/relay.ts';

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
    const { result, events, usage } = await run([
      {
        type: 'tool-call-approval',
        payload: {
          toolCallId: 't1',
          toolName: 'deleteNote',
          args: { id: 'n1' },
          usage: { inputTokens: 5, outputTokens: 1 },
        },
      },
    ]);
    expect(result).toEqual({
      status: 'awaiting_approval',
      pending: { toolCallId: 't1', toolName: 'deleteNote', args: { id: 'n1' } },
    });
    expect(events).toEqual([]);
    expect(usage).toEqual([{ inputTokens: 5, outputTokens: 1 }]);
  });

  it('ignores the usage on step-finish chunks', async () => {
    const { usage } = await run([
      { type: 'step-finish', payload: { output: { usage: { inputTokens: 5, outputTokens: 1 } } } },
    ]);
    expect(usage).toEqual([]);
  });

  it.each([
    ['abort', { type: 'abort', payload: {} }, 'aborted'],
    ['error', { type: 'error', payload: { error: new Error('x') } }, 'failed'],
    ['tripwire', { type: 'tripwire', payload: { reason: 'no' } }, 'blocked'],
  ])('ends as %s', async (_label, chunk, status) => {
    expect((await run([chunk])).result.status).toBe(status);
  });
});

describe('stepUsage', () => {
  async function record(steps: unknown[], resumed: boolean) {
    const usage: Usage[] = [];
    const onStepFinish = stepUsage(
      async (spent) => {
        usage.push(spent);
      },
      { resumed },
    );
    for (const step of steps) await onStepFinish(step as Parameters<typeof onStepFinish>[0]);
    return usage;
  }

  const step = (inputTokens: number) => ({ usage: { inputTokens, outputTokens: 1 } });

  it('records every step of a new run', async () => {
    expect(await record([step(5), step(7)], false)).toEqual([
      { inputTokens: 5, outputTokens: 1 },
      { inputTokens: 7, outputTokens: 1 },
    ]);
  });

  it('skips the repeated first step of a resumed run only', async () => {
    expect(await record([step(5), step(7), step(9)], true)).toEqual([
      { inputTokens: 7, outputTokens: 1 },
      { inputTokens: 9, outputTokens: 1 },
    ]);
  });

  it('counts missing usage as zero', async () => {
    expect(await record([{}], false)).toEqual([{ inputTokens: 0, outputTokens: 0 }]);
  });
});
