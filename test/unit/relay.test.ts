import type { ChunkType } from '@mastra/core/stream';
import { describe, expect, it } from 'vitest';
import type { Usage } from '../../src/agent/budget.ts';
import { outcomeOf, type RelayEvent, relay, stepUsage } from '../../src/agent/relay.ts';

const tokens = (inputTokens: number, outputTokens: number) => ({
  inputTokens,
  outputTokens,
  cacheReadInputTokens: 0,
  cacheWriteInputTokens: 0,
});

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
    expect(usage).toEqual([tokens(5, 1)]);
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
    expect(await record([step(5), step(7)], false)).toEqual([tokens(5, 1), tokens(7, 1)]);
  });

  it('skips the repeated first step of a resumed run only', async () => {
    expect(await record([step(5), step(7), step(9)], true)).toEqual([tokens(7, 1), tokens(9, 1)]);
  });

  it('reads cache tokens from a step’s usage', async () => {
    const cached = {
      inputTokens: 180,
      outputTokens: 20,
      cachedInputTokens: 50,
      cacheCreationInputTokens: 30,
    };
    expect(await record([{ usage: cached }], false)).toEqual([
      { inputTokens: 180, outputTokens: 20, cacheReadInputTokens: 50, cacheWriteInputTokens: 30 },
    ]);
  });

  it('counts missing usage as zero', async () => {
    expect(await record([{}], false)).toEqual([tokens(0, 0)]);
  });
});

describe('outcomeOf', () => {
  const finished = (reason: string, raw?: string) =>
    ({ status: 'completed', finish: { reason, raw } }) as const;

  it.each([
    ['stop', 'end_turn', false, { status: 'completed', reason: null }],
    ['length', 'max_tokens', false, { status: 'incomplete', reason: 'max_tokens' }],
    [
      'length',
      'model_context_window_exceeded',
      false,
      { status: 'incomplete', reason: 'context_window' },
    ],
    ['content-filter', 'refusal', false, { status: 'refused', reason: 'refusal' }],
    ['tool-calls', 'tool_use', false, { status: 'incomplete', reason: 'max_steps' }],
    ['tool-calls', 'tool_use', true, { status: 'incomplete', reason: 'token_limit' }],
  ])('maps a %s (%s) finish to its status', (reason, raw, tokenLimitReached, expected) => {
    expect(outcomeOf(finished(reason, raw), { tokenLimitReached })).toEqual(expected);
  });

  it('keeps a status the stream already set', () => {
    const result = {
      status: 'awaiting_approval',
      finish: { reason: 'tool-calls', raw: 'tool_use' },
    } as const;
    expect(outcomeOf(result)).toEqual({ status: 'awaiting_approval', reason: null });
  });
});
