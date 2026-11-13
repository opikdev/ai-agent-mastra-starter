import { and, eq, lt, sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { runs, tokenUsage } from '../db/schema.ts';
import { ProblemError } from '../platform/problem.ts';

export interface Usage {
  /** Every input token, including those read from or written to the prompt cache. */
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheWriteInputTokens: number;
}

/** Which model made a call: the agent's, or the prompt injection guardrail's. */
export type UsageRole = 'agent' | 'guardrail';

export type UsageByRole = Record<UsageRole, Usage>;

export type Transaction = Parameters<Parameters<Db['transaction']>[0]>[0];

export function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 };
}

export function noUsage(): UsageByRole {
  return { agent: emptyUsage(), guardrail: emptyUsage() };
}

export function addUsage(target: Usage, usage: Usage): void {
  target.inputTokens += usage.inputTokens;
  target.outputTokens += usage.outputTokens;
  target.cacheReadInputTokens += usage.cacheReadInputTokens;
  target.cacheWriteInputTokens += usage.cacheWriteInputTokens;
}

/** What the budget counts: input plus output tokens, whichever model spent them. */
export function tokensOf(usage: Pick<Usage, 'inputTokens' | 'outputTokens'>): number {
  return usage.inputTokens + usage.outputTokens;
}

/** Totals across every model, which is what the budget counts, plus each role's share. */
export function summarize({ agent, guardrail }: UsageByRole) {
  const total = emptyUsage();
  addUsage(total, agent);
  addUsage(total, guardrail);
  return { ...total, agent, guardrail };
}

const today = sql`(now() at time zone 'utc')::date`;

function secondsUntilUtcMidnight(now = new Date()): number {
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((midnight - now.getTime()) / 1000));
}

export interface BudgetLimits {
  dailyTokens: number;
  /** Tokens one run may spend, and so what starting one reserves. */
  runTokenLimit: number;
  maxConcurrentRuns: number;
  /** A run still marked running after this long belongs to a process that died. */
  staleAfterMs: number;
}

export function createBudget(db: Db, limits: BudgetLimits) {
  const { dailyTokens, runTokenLimit, maxConcurrentRuns, staleAfterMs } = limits;

  async function used(userId: string, executor: Db | Transaction = db): Promise<UsageByRole> {
    const [row] = await executor
      .select()
      .from(tokenUsage)
      .where(and(eq(tokenUsage.userId, userId), eq(tokenUsage.day, today)));
    if (!row) return noUsage();
    return {
      agent: {
        inputTokens: row.inputTokens - row.guardrailInputTokens,
        outputTokens: row.outputTokens - row.guardrailOutputTokens,
        cacheReadInputTokens: row.cacheReadInputTokens - row.guardrailCacheReadInputTokens,
        cacheWriteInputTokens: row.cacheWriteInputTokens - row.guardrailCacheWriteInputTokens,
      },
      guardrail: {
        inputTokens: row.guardrailInputTokens,
        outputTokens: row.guardrailOutputTokens,
        cacheReadInputTokens: row.guardrailCacheReadInputTokens,
        cacheWriteInputTokens: row.guardrailCacheWriteInputTokens,
      },
    };
  }

  /** Tokens the user's streaming runs hold but haven't spent yet. */
  async function reserved(userId: string, executor: Db | Transaction = db): Promise<number> {
    const [row] = await executor
      .select({ tokens: sql<string>`coalesce(sum(${runs.reservedTokens}), 0)` })
      .from(runs)
      .where(and(eq(runs.userId, userId), eq(runs.status, 'running')));
    return Number(row?.tokens ?? 0);
  }

  /**
   * Today's spent tokens and the user's held ones, read in one statement, so both come from the
   * same snapshot. A step that settles moves tokens from held to spent in one transaction, so the
   * sum never drops between two separate reads that could see either side of it.
   */
  async function committed(tx: Transaction, userId: string) {
    const result = await tx.execute<{ spent: string; held: string }>(sql`
      select
        coalesce((
          select ${tokenUsage.inputTokens} + ${tokenUsage.outputTokens}
          from ${tokenUsage}
          where ${tokenUsage.userId} = ${userId} and ${tokenUsage.day} = ${today}
        ), 0) as spent,
        coalesce((
          select sum(${runs.reservedTokens})
          from ${runs}
          where ${runs.userId} = ${userId} and ${runs.status} = 'running'
        ), 0) as held
    `);
    const row = result.rows[0];
    return { spent: Number(row?.spent ?? 0), held: Number(row?.held ?? 0) };
  }

  return {
    dailyTokens,
    runTokenLimit,
    used,
    reserved,

    /**
     * Holds `tokens` for a run that's about to stream, inside the caller's transaction, and
     * returns what it held. A per-user lock serializes this check, so concurrent runs can't all
     * pass it. Runs left running by a dead process are failed first, which frees what they held.
     */
    async reserve(tx: Transaction, userId: string, tokens: number): Promise<number> {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`budget:${userId}`}, 0))`,
      );
      await tx
        .update(runs)
        .set({ status: 'failed', stopReason: 'stale', pending: null, reservedTokens: 0 })
        .where(
          and(
            eq(runs.userId, userId),
            eq(runs.status, 'running'),
            lt(runs.updatedAt, sql`now() - make_interval(secs => ${staleAfterMs / 1000})`),
          ),
        );

      const [open] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(runs)
        .where(and(eq(runs.userId, userId), eq(runs.status, 'running')));
      if ((open?.count ?? 0) >= maxConcurrentRuns) {
        throw new ProblemError(
          'too-many-runs',
          `You already have ${maxConcurrentRuns} runs answering. Wait for one to finish, then retry.`,
          { headers: { 'Retry-After': '5' } },
        );
      }

      const { spent, held } = await committed(tx, userId);
      if (spent + held + tokens <= dailyTokens) return tokens;

      if (spent + tokens > dailyTokens) {
        const retryAfter = secondsUntilUtcMidnight();
        throw new ProblemError(
          'budget-exceeded',
          `A run needs ${tokens} tokens free, and ${Math.max(0, dailyTokens - spent)} of today's ${dailyTokens} are left. The budget resets at 00:00 UTC, in ${retryAfter} seconds.`,
          { headers: { 'Retry-After': String(retryAfter) } },
        );
      }
      throw new ProblemError(
        'budget-exceeded',
        `Your other runs hold ${held} tokens of today's budget until they finish. Retry once one ends.`,
        { headers: { 'Retry-After': '5' } },
      );
    },

    /**
     * Records tokens a run spent, adds them to the run's total, and takes them off its
     * reservation, in one transaction, so spent plus held never counts them twice.
     */
    async spend(runId: string, userId: string, role: UsageRole, usage: Usage): Promise<void> {
      const tokens = tokensOf(usage);
      if (tokens === 0) return;
      const guardrail = role === 'guardrail' ? usage : emptyUsage();
      await db.transaction(async (tx) => {
        await tx
          .insert(tokenUsage)
          .values({
            userId,
            day: today,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cacheReadInputTokens: usage.cacheReadInputTokens,
            cacheWriteInputTokens: usage.cacheWriteInputTokens,
            guardrailInputTokens: guardrail.inputTokens,
            guardrailOutputTokens: guardrail.outputTokens,
            guardrailCacheReadInputTokens: guardrail.cacheReadInputTokens,
            guardrailCacheWriteInputTokens: guardrail.cacheWriteInputTokens,
          })
          .onConflictDoUpdate({
            target: [tokenUsage.userId, tokenUsage.day],
            set: {
              inputTokens: sql`${tokenUsage.inputTokens} + ${usage.inputTokens}`,
              outputTokens: sql`${tokenUsage.outputTokens} + ${usage.outputTokens}`,
              cacheReadInputTokens: sql`${tokenUsage.cacheReadInputTokens} + ${usage.cacheReadInputTokens}`,
              cacheWriteInputTokens: sql`${tokenUsage.cacheWriteInputTokens} + ${usage.cacheWriteInputTokens}`,
              guardrailInputTokens: sql`${tokenUsage.guardrailInputTokens} + ${guardrail.inputTokens}`,
              guardrailOutputTokens: sql`${tokenUsage.guardrailOutputTokens} + ${guardrail.outputTokens}`,
              guardrailCacheReadInputTokens: sql`${tokenUsage.guardrailCacheReadInputTokens} + ${guardrail.cacheReadInputTokens}`,
              guardrailCacheWriteInputTokens: sql`${tokenUsage.guardrailCacheWriteInputTokens} + ${guardrail.cacheWriteInputTokens}`,
              updatedAt: sql`now()`,
            },
          });
        await tx
          .update(runs)
          .set({
            reservedTokens: sql`greatest(0, ${runs.reservedTokens} - ${tokens})`,
            spentTokens: sql`${runs.spentTokens} + ${tokens}`,
          })
          .where(eq(runs.id, runId));
      });
    },
  };
}

export type Budget = ReturnType<typeof createBudget>;
