import { describe, expect, it } from 'vitest';
import { fingerprint } from '../../src/http/idempotency.ts';

describe('fingerprint', () => {
  it('ignores key order and whitespace, at every depth', () => {
    expect(fingerprint('POST', '/v1/x', { a: 1, b: { c: [1, { d: 2, e: 3 }] } })).toBe(
      fingerprint('POST', '/v1/x', { b: { c: [1, { e: 3, d: 2 }] }, a: 1 }),
    );
  });

  it.each([
    ['the method', 'PUT', '/v1/x', { a: 1 }],
    ['the path', 'POST', '/v1/y', { a: 1 }],
    ['any field', 'POST', '/v1/x', { a: 1, added: true }],
  ])('changes with %s', (_label, method, path, body) => {
    expect(fingerprint(method, path, body)).not.toBe(fingerprint('POST', '/v1/x', { a: 1 }));
  });
});
