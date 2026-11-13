import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import {
  idempotencyKeys,
  type PendingApproval,
  type RunStatus,
  runs,
  type StopReason,
} from '../db/schema.ts';
import { ProblemError } from '../platform/problem.ts';
import { toPublicId } from '../platform/public-id.ts';
import type { Budget, Transaction } from './budget.ts';

export type Run = typeof runs.$inferSelect;

/**
 * A decision on a paused tool call that won the claim. Without `ended`, the run streams again
 * with `run.reservedTokens` to spend. With it, the budget couldn't cover the rest, so the run
 * ended with reason `budget_exceeded` and `ended` says why.
 */
export interface ApprovalClaim {
  run: Run;
  pending: PendingApproval;
  ended?: ProblemError;
}

/** Identifies a retried request: the user's key, scoped to an endpoint, and the request's hash. */
export interface Idempotency {
  endpoint: string;
  key: string;
  fingerprint: string;
}

const open: RunStatus[] = ['running', 'awaiting_approval'];
const idempotencyRetention = sql`now() + interval '24 hours'`;

function isUniqueViolation(error: unknown): boolean {
  const cause = error instanceof Error && 'cause' in error ? error.cause : error;
  return (cause as { code?: string } | undefined)?.code === '23505';
}

function busy(threadId: string) {
  return new ProblemError(
    'thread-busy',
    `Thread ${threadId} is still answering a message. Wait for it to finish, then retry.`,
    { headers: { 'Retry-After': '5' } },
  );
}

/** Claims the key, or fails with the run an earlier request with it started, and its status. */
async function claimKey(tx: Transaction, userId: string, idempotency: Idempotency) {
  const { endpoint, key, fingerprint } = idempotency;
  const [existing] = await tx
    .select({ requestHash: idempotencyKeys.requestHash, runId: runs.id, status: runs.status })
    .from(idempotencyKeys)
    .innerJoin(runs, eq(runs.id, idempotencyKeys.runId))
    .where(
      and(
        eq(idempotencyKeys.userId, userId),
        eq(idempotencyKeys.endpoint, endpoint),
        eq(idempotencyKeys.key, key),
        sql`${idempotencyKeys.expiresAt} > now()`,
      ),
    )
    .for('update', { of: idempotencyKeys });
  if (!existing) return;
  if (existing.requestHash !== fingerprint) {
    throw new ProblemError(
      'idempotency-key-reused',
      'This Idempotency-Key was used with a different request. Use a new key.',
    );
  }
  const runId = toPublicId('run', existing.runId);
  const runStatus = existing.status;
  const next =
    runStatus === 'failed'
      ? 'It failed partway and may have run a tool, so read the thread before you send the message again with a new key.'
      : 'Read its reply in the thread instead of sending the message again.';
  throw new ProblemError(
    'duplicate-request',
    `This Idempotency-Key already started run ${runId}, which is ${runStatus}. ${next}`,
    { extensions: { runId, runStatus } },
  );
}

async function saveKey(tx: Transaction, userId: string, idempotency: Idempotency, runId: string) {
  const { endpoint, key, fingerprint } = idempotency;
  await tx
    .insert(idempotencyKeys)
    .values({
      userId,
      endpoint,
      key,
      requestHash: fingerprint,
      runId,
      expiresAt: idempotencyRetention,
    })
    .onConflictDoUpdate({
      target: [idempotencyKeys.userId, idempotencyKeys.endpoint, idempotencyKeys.key],
      set: {
        requestHash: fingerprint,
        runId,
        expiresAt: idempotencyRetention,
        updatedAt: sql`now()`,
      },
      setWhere: sql`${idempotencyKeys.expiresAt} <= now()`,
    });
}

export function createRuns(db: Db, budget: Budget, staleAfterMs: number) {
  /** A run still marked running after the timeout belongs to a process that died. */
  async function expireStale(executor: Db | Transaction, threadId: string) {
    await executor
      .update(runs)
      .set({ status: 'failed', stopReason: 'stale', reservedTokens: 0 })
      .where(
        and(
          eq(runs.threadId, threadId),
          eq(runs.status, 'running'),
          lt(runs.updatedAt, sql`now() - make_interval(secs => ${staleAfterMs / 1000})`),
        ),
      );
  }

  return {
    /**
     * Opens a run on a thread and reserves its tokens, in one transaction. With an idempotency
     * key, a retry of the same request fails with the run the first one started.
     */
    async start(userId: string, threadId: string, idempotency?: Idempotency): Promise<Run> {
      try {
        return await db.transaction(async (tx) => {
          if (idempotency) await claimKey(tx, userId, idempotency);
          await expireStale(tx, threadId);
          const [current] = await tx
            .select()
            .from(runs)
            .where(and(eq(runs.threadId, threadId), inArray(runs.status, open)));
          if (current?.pending) {
            throw new ProblemError(
              'approval-pending',
              `Run ${toPublicId('run', current.id)} is waiting for approval of ${current.pending.toolName}. Approve or decline it first.`,
            );
          }
          if (current) throw busy(threadId);
          const reservedTokens = await budget.reserve(tx, userId, budget.runTokenLimit);
          const [run] = await tx
            .insert(runs)
            .values({ userId, threadId, reservedTokens })
            .returning();
          if (!run) throw new Error('Run insert returned no row');
          if (idempotency) await saveKey(tx, userId, idempotency, run.id);
          return run;
        });
      } catch (error) {
        if (isUniqueViolation(error)) throw busy(threadId);
        throw error;
      }
    },

    async find(userId: string, runId: string): Promise<Run | undefined> {
      const [run] = await db
        .select()
        .from(runs)
        .where(and(eq(runs.id, runId), eq(runs.userId, userId)));
      return run;
    },

    /**
     * Claims a paused run's decision, then reserves what's left of its token limit. Returns
     * undefined unless the run awaits this tool call, so only one of two decisions wins, and a
     * repeated one can't end the run. A run the budget can't resume ends instead of staying
     * paused, which frees its thread.
     */
    async claimApproval(runId: string, toolCallId: string): Promise<ApprovalClaim | undefined> {
      return db.transaction(async (tx) => {
        const [paused] = await tx
          .select()
          .from(runs)
          .where(
            and(
              eq(runs.id, runId),
              eq(runs.status, 'awaiting_approval'),
              sql`${runs.pending}->>'toolCallId' = ${toolCallId}`,
            ),
          )
          .for('update');
        if (!paused?.pending) return undefined;
        const left = Math.max(0, budget.runTokenLimit - paused.spentTokens);
        let reservedTokens: number;
        try {
          reservedTokens = await budget.reserve(tx, paused.userId, left);
        } catch (error) {
          if (!(error instanceof ProblemError)) throw error;
          const [ended] = await tx
            .update(runs)
            .set({ status: 'failed', stopReason: 'budget_exceeded', pending: null })
            .where(eq(runs.id, runId))
            .returning();
          if (!ended) throw new Error(`Run ${runId} vanished while locked`);
          return { run: ended, pending: paused.pending, ended: error };
        }
        const [claimed] = await tx
          .update(runs)
          .set({ status: 'running', pending: null, reservedTokens })
          .where(eq(runs.id, runId))
          .returning();
        if (!claimed) throw new Error(`Run ${runId} vanished while locked`);
        return { run: claimed, pending: paused.pending };
      });
    },

    /** Pauses for approval and frees the reservation. Approving reserves again. */
    async await(runId: string, pending: PendingApproval): Promise<void> {
      await db
        .update(runs)
        .set({ status: 'awaiting_approval', pending, reservedTokens: 0 })
        .where(eq(runs.id, runId));
    },

    /**
     * Ends the run and frees whatever it still holds of its reservation. With `releaseKey`, also
     * frees the Idempotency-Key that started it, so a retry with the same key runs again.
     */
    async finish(
      runId: string,
      status: Exclude<RunStatus, 'running' | 'awaiting_approval'>,
      stopReason: StopReason | null = null,
      { releaseKey = false } = {},
    ): Promise<void> {
      await db.transaction(async (tx) => {
        await tx
          .update(runs)
          .set({ status, stopReason, pending: null, reservedTokens: 0 })
          .where(eq(runs.id, runId));
        if (releaseKey) await tx.delete(idempotencyKeys).where(eq(idempotencyKeys.runId, runId));
      });
    },

    /** Closes a thread's open runs before it's deleted. A run that's still answering blocks it. */
    async closeThread(threadId: string): Promise<void> {
      await expireStale(db, threadId);
      const [current] = await db
        .select({ status: runs.status })
        .from(runs)
        .where(and(eq(runs.threadId, threadId), eq(runs.status, 'running')));
      if (current) throw busy(threadId);
      await db
        .update(runs)
        .set({ status: 'failed', stopReason: 'thread_deleted', pending: null })
        .where(and(eq(runs.threadId, threadId), eq(runs.status, 'awaiting_approval')));
    },

    async touch(runId: string): Promise<void> {
      await db.update(runs).set({ updatedAt: sql`now()` }).where(eq(runs.id, runId));
    },
  };
}

export type Runs = ReturnType<typeof createRuns>;
