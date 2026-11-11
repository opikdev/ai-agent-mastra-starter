import { RequestContext } from '@mastra/core/request-context';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Usage } from '../../src/agent/budget.ts';
import { guardrailUsageKey, type UsageRecorder } from '../../src/agent/context.ts';
import { countedGuardrailModel } from '../../src/agent/guardrail-usage.ts';
import { type FakeAnthropic, startFakeAnthropic } from '../fake-anthropic.ts';

type Resolve = (args: { requestContext: RequestContext }) => {
  doGenerate(options: unknown): Promise<{ stream: ReadableStream }>;
  doStream(options: unknown): Promise<{ stream: ReadableStream }>;
};

const id = 'anthropic/claude-haiku-5-5';
const call = { prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }] };

let fake: FakeAnthropic;
beforeAll(async () => {
  fake = await startFakeAnthropic();
  process.env.ANTHROPIC_BASE_URL = fake.url;
  process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
});
afterAll(() => fake.close());

function resolve(record?: UsageRecorder) {
  const requestContext = new RequestContext();
  if (record) requestContext.set(guardrailUsageKey, record);
  return (countedGuardrailModel(id) as unknown as Resolve)({ requestContext });
}

async function drain(stream: ReadableStream) {
  for await (const _ of stream);
}

describe('countedGuardrailModel', () => {
  it.each(['doGenerate', 'doStream'] as const)('reports the tokens of %s', async (method) => {
    const usage: Usage[] = [];
    const model = resolve((spent) => usage.push(spent));
    await drain((await model[method](call)).stream);
    expect(usage).toEqual([{ inputTokens: 100, outputTokens: 20 }]);
  });

  it('uses the plain model when the run has no recorder', () => {
    expect(resolve()).toBe(id);
  });
});
