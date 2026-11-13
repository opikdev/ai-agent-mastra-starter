import { sql } from 'drizzle-orm';
import { createMiddleware } from 'hono/factory';
import type { Db } from '../db/client.ts';
import { rateLimits } from '../db/schema.ts';
import { ProblemError } from '../platform/problem.ts';
import { clientIp, clientNetwork } from './client-ip.ts';
import type { AppEnv } from './router.ts';

export interface PolicyState {
  name: string;
  quota: number;
  windowSeconds: number;
  remaining: number;
  resetSeconds: number;
}

interface Policy {
  name: string;
  quota: number;
  windowSeconds: number;
}

async function hit(db: Db, key: string, policy: Policy) {
  const expired = sql`${rateLimits.resetAt} <= now()`;
  const nextReset = sql`now() + ${policy.windowSeconds}::int * interval '1 second'`;
  const [row] = await db
    .insert(rateLimits)
    .values({ key, resetAt: nextReset })
    .onConflictDoUpdate({
      target: rateLimits.key,
      set: {
        count: sql`case when ${expired} then 1 else ${rateLimits.count} + 1 end`,
        resetAt: sql`case when ${expired} then ${nextReset} else ${rateLimits.resetAt} end`,
        updatedAt: sql`now()`,
      },
    })
    .returning({ count: rateLimits.count, resetAt: rateLimits.resetAt });
  if (!row) throw new Error(`Rate limit upsert returned no row for key: ${key}`);

  const resetSeconds = Math.max(1, Math.ceil((row.resetAt.getTime() - Date.now()) / 1000));
  const state: PolicyState = {
    ...policy,
    remaining: Math.max(0, policy.quota - row.count),
    resetSeconds,
  };
  return { state, exceeded: row.count > policy.quota };
}

const policyItem = (state: PolicyState) =>
  `"${state.name}";q=${state.quota};w=${state.windowSeconds}`;
const stateItem = (state: PolicyState) =>
  `"${state.name}";r=${state.remaining};t=${state.resetSeconds}`;

interface RateLimitOptions {
  db: Db;
  name: string;
  limit: number;
  /** Limits each signed-in user when true, and each client network otherwise. */
  perUser?: boolean;
  /** Proxies in front of the server, which say who the client is in X-Forwarded-For. */
  trustedProxyHops: number;
}

/**
 * Counts requests per client network, or per user, each minute, and sends the RateLimit and
 * RateLimit-Policy headers of draft-ietf-httpapi-ratelimit-headers. The innermost limiter writes
 * the headers for every policy applied so far, and a 429 keeps the state of the policy it exceeded.
 */
export function rateLimit({
  db,
  name,
  limit,
  perUser = false,
  trustedProxyHops,
}: RateLimitOptions) {
  const policy = { name, quota: limit, windowSeconds: 60 };
  return createMiddleware<AppEnv>(async (c, next) => {
    const subject = perUser
      ? `user:${c.get('user').userId}`
      : clientNetwork(clientIp(c, trustedProxyHops));
    const { state, exceeded } = await hit(db, `${name}:${subject}`, policy);
    const policies = [...(c.get('rateLimits') ?? []), state];
    c.set('rateLimits', policies);

    if (exceeded) {
      throw new ProblemError(
        'rate-limited',
        `You've reached the limit of ${limit} requests per minute. Retry in ${state.resetSeconds} seconds.`,
        {
          headers: {
            'RateLimit-Policy': policies.map(policyItem).join(', '),
            RateLimit: stateItem(state),
            'Retry-After': String(state.resetSeconds),
          },
        },
      );
    }

    await next();
    if (!c.res.headers.has('RateLimit')) {
      c.header('RateLimit-Policy', policies.map(policyItem).join(', '));
      c.header('RateLimit', policies.map(stateItem).join(', '));
    }
  });
}
