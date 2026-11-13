import { and, eq, inArray, lt, lte, sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { idempotencyKeys, type RunStatus, rateLimits, runs, tokenUsage } from '../db/schema.ts';

export interface Retention {
  runRetentionDays: number;
  approvalTtlHours: number;
  /** A run still running after this long belongs to a process that died. */
  staleRunMs: number;
}

/** Any fixed number works, as long as nothing else in the database uses it as a lock. */
export const cleanupLockId = 418_027;

const finished: RunStatus[] = ['completed', 'incomplete', 'refused', 'blocked', 'failed'];

/**
 * Deletes expired rows, fails approvals nobody answered so their threads unlock, and fails runs
 * a dead process left running, which frees the tokens they reserved. Replicas take an advisory
 * lock, so only one cleans at a time. Returns false when another one holds it.
 */
export async function deleteExpiredRows(db: Db, retention: Retention): Promise<boolean> {
  const retainFrom = sql`(now() - make_interval(days => ${retention.runRetentionDays}::int))`;
  const approvalExpiry = sql`(now() - make_interval(hours => ${retention.approvalTtlHours}::int))`;
  const staleBefore = sql`(now() - make_interval(secs => ${retention.staleRunMs / 1000}))`;
  return db.transaction(async (tx) => {
    const { rows } = await tx.execute<{ locked: boolean }>(
      sql`select pg_try_advisory_xact_lock(${cleanupLockId}) as locked`,
    );
    if (!rows[0]?.locked) return false;
    await tx.delete(rateLimits).where(lte(rateLimits.resetAt, sql`now()`));
    await tx.delete(idempotencyKeys).where(lte(idempotencyKeys.expiresAt, sql`now()`));
    await tx
      .update(runs)
      .set({ status: 'failed', stopReason: 'approval_expired', pending: null })
      .where(and(eq(runs.status, 'awaiting_approval'), lt(runs.updatedAt, approvalExpiry)));
    await tx
      .update(runs)
      .set({ status: 'failed', stopReason: 'stale', reservedTokens: 0 })
      .where(and(eq(runs.status, 'running'), lt(runs.updatedAt, staleBefore)));
    await tx
      .delete(runs)
      .where(and(inArray(runs.status, finished), lt(runs.updatedAt, retainFrom)));
    await tx
      .delete(tokenUsage)
      .where(lt(tokenUsage.day, sql`(${retainFrom} at time zone 'utc')::date`));
    return true;
  });
}
