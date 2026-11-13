import { createHash } from 'node:crypto';
import type { Context } from 'hono';
import { routePath } from 'hono/route';
import type { Idempotency } from '../agent/runs.ts';

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item !== null && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : item,
  );
}

/** Hashes the method, path, and whole validated body, with keys sorted, so every field counts. */
export function fingerprint(method: string, path: string, body: unknown): string {
  return createHash('sha256')
    .update(`${method} ${path}\n${canonicalJson(body)}`)
    .digest('hex');
}

/**
 * Scopes a key to the route, such as `POST /v1/threads/:id/messages`, and fingerprints the
 * request, so a key reused for a different thread or message is rejected.
 */
export function idempotencyOf(c: Context, key: string | undefined, body: unknown) {
  if (!key) return undefined;
  return {
    endpoint: `${c.req.method} ${routePath(c)}`,
    key,
    fingerprint: fingerprint(c.req.method, c.req.path, body),
  } satisfies Idempotency;
}
