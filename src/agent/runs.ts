import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { type PendingApproval, type RunStatus, runs } from '../db/schema.ts';
import { ProblemError } from '../http/problem.ts';

export type Run = typeof runs.$inferSelect;

const open: RunStatus[] = ['running', 'awaiting_approval'];

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

export function createRuns(db: Db, staleAfterMs: number) {
  /** A run still marked running after the timeout belongs to a process that died. */
  async function expireStale(threadId: string) {
    await db
      .update(runs)
      .set({ status: 'failed' })
      .where(
        and(
          eq(runs.threadId, threadId),
          eq(runs.status, 'running'),
          lt(runs.updatedAt, sql`now() - make_interval(secs => ${staleAfterMs / 1000})`),
        ),
      );
  }

  return {
    async start(userId: string, threadId: string): Promise<Run> {
      await expireStale(threadId);
      const [current] = await db
        .select()
        .from(runs)
        .where(and(eq(runs.threadId, threadId), inArray(runs.status, open)));
      if (current?.pending) {
        throw new ProblemError(
          'approval-pending',
          `Run ${current.id} is waiting for approval of ${current.pending.toolName}. Approve or decline it first.`,
        );
      }
      if (current) throw busy(threadId);
      try {
        const [run] = await db.insert(runs).values({ userId, threadId }).returning();
        if (!run) throw new Error('Run insert returned no row');
        return run;
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

    /** Moves an awaiting run back to running. Only one of two concurrent approvals wins. */
    async claimApproval(run: Run, toolCallId: string): Promise<PendingApproval | undefined> {
      const [claimed] = await db
        .update(runs)
        .set({ status: 'running', pending: null })
        .where(
          and(
            eq(runs.id, run.id),
            eq(runs.status, 'awaiting_approval'),
            sql`${runs.pending}->>'toolCallId' = ${toolCallId}`,
          ),
        )
        .returning({ id: runs.id });
      return claimed && run.pending ? run.pending : undefined;
    },

    async await(runId: string, pending: PendingApproval): Promise<void> {
      await db.update(runs).set({ status: 'awaiting_approval', pending }).where(eq(runs.id, runId));
    },

    async finish(runId: string, status: Exclude<RunStatus, 'awaiting_approval'>): Promise<void> {
      await db.update(runs).set({ status, pending: null }).where(eq(runs.id, runId));
    },

    /** Closes a thread's open runs before it's deleted. A run that's still answering blocks it. */
    async closeThread(threadId: string): Promise<void> {
      await expireStale(threadId);
      const [current] = await db
        .select({ status: runs.status })
        .from(runs)
        .where(and(eq(runs.threadId, threadId), eq(runs.status, 'running')));
      if (current) throw busy(threadId);
      await db
        .update(runs)
        .set({ status: 'failed', pending: null })
        .where(and(eq(runs.threadId, threadId), eq(runs.status, 'awaiting_approval')));
    },

    async touch(runId: string): Promise<void> {
      await db.update(runs).set({ updatedAt: sql`now()` }).where(eq(runs.id, runId));
    },
  };
}

export type Runs = ReturnType<typeof createRuns>;
