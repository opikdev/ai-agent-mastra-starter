import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { tokenUsage } from '../db/schema.ts';
import { ProblemError } from '../http/problem.ts';

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

const today = sql`(now() at time zone 'utc')::date`;

function secondsUntilUtcMidnight(now = new Date()): number {
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((midnight - now.getTime()) / 1000));
}

export function createBudget(db: Db, dailyTokens: number) {
  async function used(userId: string): Promise<Usage> {
    const [row] = await db
      .select({ inputTokens: tokenUsage.inputTokens, outputTokens: tokenUsage.outputTokens })
      .from(tokenUsage)
      .where(and(eq(tokenUsage.userId, userId), eq(tokenUsage.day, today)));
    return row ?? { inputTokens: 0, outputTokens: 0 };
  }

  return {
    dailyTokens,
    used,

    /** Refuses a new run once today's spend reaches the budget. A run in flight may finish over it. */
    async check(userId: string): Promise<void> {
      const { inputTokens, outputTokens } = await used(userId);
      if (inputTokens + outputTokens < dailyTokens) return;
      const retryAfter = secondsUntilUtcMidnight();
      throw new ProblemError(
        'budget-exceeded',
        `You've used today's budget of ${dailyTokens} tokens. It resets at 00:00 UTC, in ${retryAfter} seconds.`,
        { headers: { 'Retry-After': String(retryAfter) } },
      );
    },

    async record(userId: string, { inputTokens, outputTokens }: Usage): Promise<void> {
      if (inputTokens === 0 && outputTokens === 0) return;
      await db
        .insert(tokenUsage)
        .values({ userId, day: today, inputTokens, outputTokens })
        .onConflictDoUpdate({
          target: [tokenUsage.userId, tokenUsage.day],
          set: {
            inputTokens: sql`${tokenUsage.inputTokens} + ${inputTokens}`,
            outputTokens: sql`${tokenUsage.outputTokens} + ${outputTokens}`,
            updatedAt: sql`now()`,
          },
        });
    },
  };
}

export type Budget = ReturnType<typeof createBudget>;
