import { context, type SpanContext, TraceFlags, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger, serializeError } from '../../src/platform/logger.ts';

function providerError() {
  return Object.assign(new Error('invalid request'), {
    name: 'AI_APICallError',
    url: 'https://api.anthropic.com/v1/messages',
    statusCode: 400,
    isRetryable: false,
    requestBodyValues: { messages: [{ role: 'user', content: 'my secret plans' }] },
    responseBody: '{"error":"my secret plans"}',
  });
}

describe('serializeError', () => {
  it('keeps what failed and drops the request it carried', () => {
    const serialized = serializeError(providerError());
    expect(serialized).toMatchObject({
      type: 'AI_APICallError',
      message: 'invalid request',
      statusCode: 400,
      url: 'https://api.anthropic.com/v1/messages',
      isRetryable: false,
    });
    expect(JSON.stringify(serialized)).not.toContain('my secret plans');
  });

  it('reduces the cause too', () => {
    const wrapped = new Error('Agent stream failed', { cause: providerError() });
    const serialized = serializeError(wrapped);
    expect(serialized.cause).toMatchObject({ statusCode: 400 });
    expect(JSON.stringify(serialized)).not.toContain('my secret plans');
  });

  it('logs a thrown value that isn’t an Error as text', () => {
    expect(serializeError('boom')).toEqual({ message: 'boom' });
  });

  it.each(['err', 'error'])('applies to the %s key', (key) => {
    const lines: string[] = [];
    const logger = createLogger('info', { write: (line: string) => void lines.push(line) });
    logger.error({ [key]: providerError() }, 'Failed');
    expect(lines.join('')).toContain('invalid request');
    expect(lines.join('')).not.toContain('my secret plans');
  });
});

function capture(entry: Record<string, unknown>): string {
  let output = '';
  const logger = createLogger('info', {
    write: (line) => {
      output += line;
    },
  });
  logger.info(entry, 'test');
  return output;
}

describe('trace context', () => {
  const contextManager = new AsyncLocalStorageContextManager();

  beforeAll(() => {
    context.setGlobalContextManager(contextManager.enable());
  });

  afterAll(() => {
    contextManager.disable();
    context.disable();
  });

  function captureInSpan(spanContext: SpanContext): string {
    const span = trace.wrapSpanContext(spanContext);
    return context.with(trace.setSpan(context.active(), span), () => capture({ status: 200 }));
  }

  it('adds the trace and span IDs of the active span', () => {
    const output = captureInSpan({
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      spanId: '00f067aa0ba902b7',
      traceFlags: TraceFlags.SAMPLED,
    });
    expect(output).toContain('"trace_id":"4bf92f3577b34da6a3ce929d0e0e4736"');
    expect(output).toContain('"span_id":"00f067aa0ba902b7"');
  });

  it('leaves them out without a valid span', () => {
    expect(capture({ status: 200 })).not.toContain('trace_id');
    const output = captureInSpan({
      traceId: '00000000000000000000000000000000',
      spanId: '0000000000000000',
      traceFlags: TraceFlags.NONE,
    });
    expect(output).not.toContain('trace_id');
  });
});
