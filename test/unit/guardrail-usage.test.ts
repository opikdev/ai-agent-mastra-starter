import { RequestContext } from '@mastra/core/request-context';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Usage } from '../../src/agent/budget.ts';
import { type GuardrailMonitor, guardrailMonitorKey } from '../../src/agent/context.ts';
import { monitoredGuardrailModel, usageOf } from '../../src/agent/guardrail-usage.ts';
import { type FakeAnthropic, startFakeAnthropic } from '../fake-anthropic.ts';

type Resolve = (args: { requestContext: RequestContext }) => {
  doGenerate(options: unknown): Promise<{ stream: ReadableStream }>;
  doStream(options: unknown): Promise<{ stream: ReadableStream }>;
};

const id = 'anthropic/claude-haiku-5-5';
const call = { prompt: [{ role: 'user', content: [{ type: 'text', text: 'my secret plans' }] }] };

let fake: FakeAnthropic;
beforeAll(async () => {
  fake = await startFakeAnthropic();
  process.env.ANTHROPIC_BASE_URL = fake.url;
  process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
});
afterAll(() => fake.close());

function resolve(monitor?: GuardrailMonitor) {
  const requestContext = new RequestContext();
  if (monitor) requestContext.set(guardrailMonitorKey, monitor);
  return (monitoredGuardrailModel(id) as unknown as Resolve)({ requestContext });
}

async function drain(stream: ReadableStream) {
  for await (const _ of stream);
}

function monitor() {
  const usage: Usage[] = [];
  const failures: unknown[] = [];
  return {
    usage,
    failures,
    monitor: {
      record: (spent: Usage) => usage.push(spent),
      failed: (e: unknown) => failures.push(e),
    },
  };
}

describe('monitoredGuardrailModel', () => {
  it.each(['doGenerate', 'doStream'] as const)('reports the tokens of %s', async (method) => {
    const watched = monitor();
    await drain((await resolve(watched.monitor)[method](call)).stream);
    expect(watched.usage).toEqual([
      { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 },
    ]);
    expect(watched.failures).toEqual([]);
  });

  it('reports a failed call without the prompt it carried', async () => {
    const watched = monitor();
    fake.guardScores.push(-1);
    const model = resolve(watched.monitor);
    const failed = await model
      .doGenerate({ ...call, responseFormat: { type: 'json', schema: { type: 'object' } } })
      .then(
        (result) => drain(result.stream),
        (error: unknown) => error,
      );
    expect(failed).toBeInstanceOf(Error);
    expect(watched.failures).toHaveLength(1);
    expect(JSON.stringify(watched.failures[0])).not.toContain('my secret plans');
  });

  it('uses the plain model when the run has no monitor', () => {
    expect(resolve()).toBe(id);
  });
});

describe('usageOf', () => {
  it('reads cache tokens from the provider’s usage, and plain numbers as totals', () => {
    expect(
      usageOf({ inputTokens: { total: 180, cacheRead: 50, cacheWrite: 30 }, outputTokens: 20 }),
    ).toEqual({
      inputTokens: 180,
      outputTokens: 20,
      cacheReadInputTokens: 50,
      cacheWriteInputTokens: 30,
    });
  });
});
