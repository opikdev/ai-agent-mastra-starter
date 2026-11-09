import { createHash } from 'node:crypto';
import { createMiddleware } from 'hono/factory';
import { createNotesClient, type NotesClient, UpstreamError } from '../notes/client.ts';
import type { AppEnv } from './env.ts';
import { ProblemError } from './problem.ts';

interface AuthOptions {
  notesApiUrl: string;
  timeoutMs: number;
  cacheTtlMs?: number;
  fetch?: typeof fetch;
}

const maxTokenLength = 512;
const maxCachedTokens = 10_000;

function unauthorized(detail: string) {
  return new ProblemError('unauthorized', detail, { headers: { 'WWW-Authenticate': 'Bearer' } });
}

/**
 * Accepts the notes API's own bearer tokens. The notes API says who the caller is, and every tool
 * call runs with the same token, so the agent can never do more than the user could.
 */
export function createRequireAuth({
  notesApiUrl,
  timeoutMs,
  cacheTtlMs = 30_000,
  fetch: fetcher,
}: AuthOptions) {
  const verified = new Map<string, { userId: string; expiresAt: number }>();

  async function identify(token: string, notes: NotesClient): Promise<string> {
    const key = createHash('sha256').update(token).digest('hex');
    const cached = verified.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.userId;
    verified.delete(key);

    let userId: string;
    try {
      userId = (await notes.me()).id;
    } catch (error) {
      if (error instanceof UpstreamError && error.status === 401) {
        throw unauthorized('The token is invalid or expired. Log in to the notes API again.');
      }
      throw new ProblemError(
        'service-unavailable',
        "Couldn't check the token with the notes API. Retry shortly.",
        { cause: error, headers: { 'Retry-After': '5' } },
      );
    }
    if (verified.size >= maxCachedTokens) {
      const oldest = verified.keys().next().value;
      if (oldest) verified.delete(oldest);
    }
    verified.set(key, { userId, expiresAt: Date.now() + cacheTtlMs });
    return userId;
  }

  return createMiddleware<AppEnv>(async (c, next) => {
    const [scheme, token, ...rest] = (c.req.header('authorization') ?? '').split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !token || rest.length > 0) {
      throw unauthorized('Send a notes API token as Authorization: Bearer <token>.');
    }
    if (token.length > maxTokenLength) throw unauthorized('The token is too long.');
    const notes = createNotesClient({
      baseUrl: notesApiUrl,
      token,
      timeoutMs,
      ...(fetcher ? { fetch: fetcher } : {}),
    });
    c.set('user', { userId: await identify(token, notes), notes });
    await next();
  });
}
