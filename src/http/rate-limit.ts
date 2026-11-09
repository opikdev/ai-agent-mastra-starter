import { sql } from 'drizzle-orm';
import { createMiddleware } from 'hono/factory';
import type { Db } from '../db/client.ts';
import { rateLimits } from '../db/schema.ts';
import { clientIp } from './client-ip.ts';
import type { AppEnv } from './env.ts';
import { ProblemError } from './problem.ts';

const windowInterval = sql`interval '1 minute'`;

async function hit(db: Db, key: string) {
  const expired = sql`${rateLimits.resetAt} <= now()`;
  const [row] = await db
    .insert(rateLimits)
    .values({ key, resetAt: sql`now() + ${windowInterval}` })
    .onConflictDoUpdate({
      target: rateLimits.key,
      set: {
        count: sql`case when ${expired} then 1 else ${rateLimits.count} + 1 end`,
        resetAt: sql`case when ${expired} then now() + ${windowInterval} else ${rateLimits.resetAt} end`,
        updatedAt: sql`now()`,
      },
    })
    .returning({ count: rateLimits.count, resetAt: rateLimits.resetAt });
  if (!row) throw new Error(`Rate limit upsert returned no row for key: ${key}`);
  return row;
}

interface RateLimitOptions {
  db: Db;
  name: string;
  limit: number;
  /** Limits each signed-in user when true, and each client IP otherwise. */
  perUser?: boolean;
  trustProxy: boolean;
}

export function rateLimit({ db, name, limit, perUser = false, trustProxy }: RateLimitOptions) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const subject = perUser ? `user:${c.get('user').userId}` : clientIp(c, trustProxy);
    const { count, resetAt } = await hit(db, `${name}:${subject}`);
    const secondsUntilReset = Math.max(1, Math.ceil((resetAt.getTime() - Date.now()) / 1000));
    const headers = {
      'RateLimit-Limit': String(limit),
      'RateLimit-Remaining': String(Math.max(0, limit - count)),
      'RateLimit-Reset': String(secondsUntilReset),
    };
    if (count > limit) {
      throw new ProblemError(
        'rate-limited',
        `You've reached the limit of ${limit} requests per minute. Retry in ${secondsUntilReset} seconds.`,
        { headers: { ...headers, 'Retry-After': String(secondsUntilReset) } },
      );
    }
    for (const [header, value] of Object.entries(headers)) c.header(header, value);
    await next();
  });
}
