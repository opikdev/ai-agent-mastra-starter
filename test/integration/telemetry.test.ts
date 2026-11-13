import { context, metrics, propagation, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import {
  AggregationTemporality,
  MeterProvider,
  MetricReader,
  type ResourceMetrics,
} from '@opentelemetry/sdk-metrics';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventsOf, startStack, type TestStack } from '../helpers.ts';

class TestReader extends MetricReader {
  constructor() {
    super({ aggregationTemporalitySelector: () => AggregationTemporality.CUMULATIVE });
  }
  protected async onForceFlush() {}
  protected async onShutdown() {}
}

const reader = new TestReader();
const contextManager = new AsyncLocalStorageContextManager();
let stack: TestStack;

beforeAll(async () => {
  context.setGlobalContextManager(contextManager.enable());
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  metrics.setGlobalMeterProvider(new MeterProvider({ readers: [reader] }));
  stack = await startStack();
});

afterAll(async () => {
  await stack.close();
  contextManager.disable();
  context.disable();
  propagation.disable();
  metrics.disable();
});

interface HistogramPoint {
  attributes: Record<string, unknown>;
  value: { sum: number; count: number };
}

function points(collected: ResourceMetrics, name: string): HistogramPoint[] {
  return collected.scopeMetrics
    .flatMap((scope) => scope.metrics)
    .filter((metric) => metric.descriptor.name === name)
    .flatMap((metric) => metric.dataPoints as unknown as HistogramPoint[]);
}

describe('telemetry', () => {
  it('sends the trace context to the notes API from a tool call', async () => {
    const user = stack.signUp();
    const thread = await user.createThread();
    stack.reply({ tool: { name: 'listNotes', input: {} } }, { text: 'None.' });
    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
    const span = trace.wrapSpanContext({ traceId, spanId: '00f067aa0ba902b7', traceFlags: 1 });
    await context.with(trace.setSpan(context.active(), span), () =>
      user.say(thread.id, 'What notes do I have?'),
    );
    const call = stack.notesApi.requests.findLast(
      (request) => new URL(request.url).pathname === '/v1/notes',
    );
    expect(call?.headers.get('traceparent')).toMatch(new RegExp(`^00-${traceId}-[0-9a-f]{16}-01$`));
  });

  it('records runs and tokens as OTLP metrics', async () => {
    const user = stack.signUp();
    const thread = await user.createThread();
    const events = await user.say(thread.id, 'Hi');
    expect(eventsOf(events, 'done')[0].status).toBe('completed');

    const { resourceMetrics } = await reader.collect();
    const runs = points(resourceMetrics, 'agent.run.duration');
    expect(
      runs.find((point) => point.attributes['agent.run.status'] === 'completed')?.value.count,
    ).toBeGreaterThan(0);
    const tokens = points(resourceMetrics, 'gen_ai.client.token.usage');
    const input = tokens.find(
      (point) =>
        point.attributes['gen_ai.token.type'] === 'input' &&
        point.attributes['gen_ai.request.model'] === 'claude-sonnet-5-5',
    );
    expect(input?.value.sum).toBeGreaterThanOrEqual(100);
  });
});
