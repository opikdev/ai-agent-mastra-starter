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

/** Claims the key, or fails with the run an earlier request with it started. */
async function claimKey(tx: Transaction, userId: string, idempotency: Idempotency) {
  const { endpoint, key, fingerprint } = idempotency;
  const [existing] = await tx
    .select()
    .from(idempotencyKeys)
    .where(
      and(
        eq(idempotencyKeys.userId, userId),
        eq(idempotencyKeys.endpoint, endpoint),
        eq(idempotencyKeys.key, key),
        sql`${idempotencyKeys.expiresAt} > now()`,
      ),
    )
    .for('update');
  if (!existing) return;
  if (existing.requestHash !== fingerprint) {
    throw new ProblemError(
      'idempotency-key-reused',
      'This Idempotency-Key was used with a different request. Use a new key.',
    );
  }
  const runId = toPublicId('run', existing.runId);
  throw new ProblemError(
    'duplicate-request',
    `This Idempotency-Key already started run ${runId}. Read its reply in the thread instead of sending the message again.`,
    { extensions: { runId } },
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
          const reservedTokens = await budget.reserve(tx, userId);
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
     * Moves an awaiting run back to running and reserves its tokens. Only one of two concurrent
     * approvals wins.
     */
    async claimApproval(run: Run, toolCallId: string): Promise<PendingApproval | undefined> {
      return db.transaction(async (tx) => {
        const reservedTokens = await budget.reserve(tx, run.userId);
        const [claimed] = await tx
          .update(runs)
          .set({ status: 'running', pending: null, reservedTokens })
          .where(
            and(
              eq(runs.id, run.id),
              eq(runs.status, 'awaiting_approval'),
              sql`${runs.pending}->>'toolCallId' = ${toolCallId}`,
            ),
          )
          .returning({ id: runs.id });
        return claimed && run.pending ? run.pending : undefined;
      });
    },

    /** Pauses for approval and frees the reservation. Approving reserves again. */
    async await(runId: string, pending: PendingApproval): Promise<void> {
      await db
        .update(runs)
        .set({ status: 'awaiting_approval', pending, reservedTokens: 0 })
        .where(eq(runs.id, runId));
    },

    /** Ends the run and frees whatever it still holds of its reservation. */
    async finish(
      runId: string,
      status: Exclude<RunStatus, 'running' | 'awaiting_approval'>,
      stopReason: StopReason | null = null,
    ): Promise<void> {
      await db
        .update(runs)
        .set({ status, stopReason, pending: null, reservedTokens: 0 })
        .where(eq(runs.id, runId));
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
