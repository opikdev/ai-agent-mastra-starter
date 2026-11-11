import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { tokenUsage } from '../db/schema.ts';
import { ProblemError } from '../platform/problem.ts';

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

/** Which model made a call: the agent's, or the prompt injection guardrail's. */
export type UsageRole = 'agent' | 'guardrail';

export type UsageByRole = Record<UsageRole, Usage>;

export function noUsage(): UsageByRole {
  return {
    agent: { inputTokens: 0, outputTokens: 0 },
    guardrail: { inputTokens: 0, outputTokens: 0 },
  };
}

/** Totals across every model, which is what the budget counts, plus each role's share. */
export function summarize({ agent, guardrail }: UsageByRole) {
  return {
    inputTokens: agent.inputTokens + guardrail.inputTokens,
    outputTokens: agent.outputTokens + guardrail.outputTokens,
    agent,
    guardrail,
  };
}

const today = sql`(now() at time zone 'utc')::date`;

function secondsUntilUtcMidnight(now = new Date()): number {
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((midnight - now.getTime()) / 1000));
}

export function createBudget(db: Db, dailyTokens: number) {
  async function used(userId: string): Promise<UsageByRole> {
    const [row] = await db
      .select({
        inputTokens: tokenUsage.inputTokens,
        outputTokens: tokenUsage.outputTokens,
        guardrailInputTokens: tokenUsage.guardrailInputTokens,
        guardrailOutputTokens: tokenUsage.guardrailOutputTokens,
      })
      .from(tokenUsage)
      .where(and(eq(tokenUsage.userId, userId), eq(tokenUsage.day, today)));
    if (!row) return noUsage();
    return {
      agent: {
        inputTokens: row.inputTokens - row.guardrailInputTokens,
        outputTokens: row.outputTokens - row.guardrailOutputTokens,
      },
      guardrail: { inputTokens: row.guardrailInputTokens, outputTokens: row.guardrailOutputTokens },
    };
  }

  return {
    dailyTokens,
    used,

    /** Refuses a new run once today's spend reaches the budget. A run in flight may finish over it. */
    async check(userId: string): Promise<void> {
      const { inputTokens, outputTokens } = summarize(await used(userId));
      if (inputTokens + outputTokens < dailyTokens) return;
      const retryAfter = secondsUntilUtcMidnight();
      throw new ProblemError(
        'budget-exceeded',
        `You've used today's budget of ${dailyTokens} tokens. It resets at 00:00 UTC, in ${retryAfter} seconds.`,
        { headers: { 'Retry-After': String(retryAfter) } },
      );
    },

    async record(
      userId: string,
      role: UsageRole,
      { inputTokens, outputTokens }: Usage,
    ): Promise<void> {
      if (inputTokens === 0 && outputTokens === 0) return;
      const guardrailInputTokens = role === 'guardrail' ? inputTokens : 0;
      const guardrailOutputTokens = role === 'guardrail' ? outputTokens : 0;
      await db
        .insert(tokenUsage)
        .values({
          userId,
          day: today,
          inputTokens,
          outputTokens,
          guardrailInputTokens,
          guardrailOutputTokens,
        })
        .onConflictDoUpdate({
          target: [tokenUsage.userId, tokenUsage.day],
          set: {
            inputTokens: sql`${tokenUsage.inputTokens} + ${inputTokens}`,
            outputTokens: sql`${tokenUsage.outputTokens} + ${outputTokens}`,
            guardrailInputTokens: sql`${tokenUsage.guardrailInputTokens} + ${guardrailInputTokens}`,
            guardrailOutputTokens: sql`${tokenUsage.guardrailOutputTokens} + ${guardrailOutputTokens}`,
            updatedAt: sql`now()`,
          },
        });
    },
  };
}

export type Budget = ReturnType<typeof createBudget>;
