import { describe, expect, it } from 'vitest';
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
