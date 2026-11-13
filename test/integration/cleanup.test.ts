import { randomUUID } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createBudget } from '../../src/agent/budget.ts';
import { deleteInactiveThreads } from '../../src/agent/retention.ts';
import { createRuns } from '../../src/agent/runs.ts';
import { idempotencyKeys, rateLimits, runs, tokenUsage } from '../../src/db/schema.ts';
import { cleanupLockId, deleteExpiredRows } from '../../src/platform/cleanup.ts';
import { eventsOf, startStack, type TestStack } from '../helpers.ts';

const retention = { runRetentionDays: 30, approvalTtlHours: 24, staleRunMs: 150_000 };
const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000);
const daysAgo = (days: number) => hoursAgo(days * 24);
const pending = { toolCallId: 'toolu_1', toolName: 'deleteNote', args: { id: 'note_1' } };

let stack: TestStack;
beforeAll(async () => {
  stack = await startStack();
});
afterAll(() => stack.close());

async function insertRun(values: Partial<typeof runs.$inferInsert>) {
  const [run] = await stack.db
    .insert(runs)
    .values({ userId: `usr_${randomUUID()}`, threadId: `thr_${randomUUID()}`, ...values })
    .returning();
  if (!run) throw new Error('Run insert returned no row');
  return run;
}

async function statusOf(id: string) {
  const [run] = await stack.db.select({ status: runs.status }).from(runs).where(eq(runs.id, id));
  return run?.status ?? 'deleted';
}

describe('cleanup', () => {
  it('deletes finished runs past retention and keeps recent and open ones', async () => {
    const old = await insertRun({ status: 'completed', updatedAt: daysAgo(31) });
    const recent = await insertRun({ status: 'failed', updatedAt: daysAgo(29) });
    const awaiting = await insertRun({
      status: 'awaiting_approval',
      pending,
      updatedAt: hoursAgo(1),
    });
    const running = await insertRun({ status: 'running', updatedAt: new Date() });

    expect(await deleteExpiredRows(stack.db, retention)).toBe(true);

    expect(await statusOf(old.id)).toBe('deleted');
    expect(await statusOf(recent.id)).toBe('failed');
    expect(await statusOf(awaiting.id)).toBe('awaiting_approval');
    expect(await statusOf(running.id)).toBe('running');
  });

  it('fails runs a dead process left running, and frees their tokens', async () => {
    const stale = await insertRun({ reservedTokens: 5000, updatedAt: hoursAgo(1) });
    await deleteExpiredRows(stack.db, retention);
    const [row] = await stack.db.select().from(runs).where(eq(runs.id, stale.id));
    expect(row).toMatchObject({ status: 'failed', stopReason: 'stale', reservedTokens: 0 });
  });

  it('fails approvals nobody answered within the TTL, so the thread takes messages again', async () => {
    const user = stack.signUp();
    const thread = await user.createThread();
    const abandoned = await insertRun({
      userId: user.id,
      threadId: thread.id,
      status: 'awaiting_approval',
      pending,
      updatedAt: hoursAgo(25),
    });
    const waiting = await insertRun({
      status: 'awaiting_approval',
      pending,
      updatedAt: hoursAgo(23),
    });

    await deleteExpiredRows(stack.db, retention);

    expect(await statusOf(abandoned.id)).toBe('failed');
    expect(await statusOf(waiting.id)).toBe('awaiting_approval');
    expect(eventsOf(await user.say(thread.id, 'hi'), 'done')[0].status).toBe('completed');
  });

  it('deletes token usage and rate limits past their time', async () => {
    const userId = `usr_${randomUUID()}`;
    const day = (date: Date) => date.toISOString().slice(0, 10);
    await stack.db.insert(tokenUsage).values([
      { userId, day: day(daysAgo(31)), inputTokens: 1, outputTokens: 1 },
      { userId, day: day(daysAgo(1)), inputTokens: 1, outputTokens: 1 },
    ]);
    const key = `test:${randomUUID()}`;
    await stack.db.insert(rateLimits).values({ key, resetAt: hoursAgo(1) });
    const idempotency = {
      userId,
      endpoint: 'POST /v1/test',
      requestHash: 'x',
      runId: randomUUID(),
    };
    await stack.db.insert(idempotencyKeys).values([
      { ...idempotency, key: 'old', expiresAt: hoursAgo(1) },
      { ...idempotency, key: 'new', expiresAt: daysAgo(-1) },
    ]);

    await deleteExpiredRows(stack.db, retention);

    const usage = await stack.db.select().from(tokenUsage).where(eq(tokenUsage.userId, userId));
    expect(usage.map((row) => row.day)).toEqual([day(daysAgo(1))]);
    expect(
      await stack.db
        .select()
        .from(rateLimits)
        .where(inArray(rateLimits.key, [key])),
    ).toEqual([]);
    const keys = await stack.db
      .select({ key: idempotencyKeys.key })
      .from(idempotencyKeys)
      .where(eq(idempotencyKeys.userId, userId));
    expect(keys).toEqual([{ key: 'new' }]);
  });

  it('leaves the work to the replica that holds the lock', async () => {
    const old = await insertRun({ status: 'completed', updatedAt: daysAgo(31) });
    const other = new pg.Client({ connectionString: inject('databaseUrl') });
    await other.connect();
    try {
      await other.query('select pg_advisory_lock($1)', [cleanupLockId]);
      expect(await deleteExpiredRows(stack.db, retention)).toBe(false);
      expect(await statusOf(old.id)).toBe('completed');
    } finally {
      await other.end();
    }
  });
});

describe('thread retention', () => {
  const limits = {
    dailyTokens: 1000,
    runTokenLimit: 100,
    maxConcurrentRuns: 3,
    staleAfterMs: 150_000,
  };

  async function age(threadId: string, days: number) {
    await stack.db.execute(
      sql`update mastra.mastra_threads set "updatedAt" = now() - make_interval(days => ${days}), "updatedAtZ" = now() - make_interval(days => ${days}) where id = ${threadId}`,
    );
  }

  it('deletes threads nobody used within the retention, except one still answering', async () => {
    const user = stack.signUp();
    const [old, busy, recent] = [
      await user.createThread(),
      await user.createThread(),
      await user.createThread(),
    ];
    await age(old.id, 91);
    await age(busy.id, 91);
    await age(recent.id, 89);
    await insertRun({
      userId: user.id,
      threadId: busy.id,
      status: 'running',
      updatedAt: new Date(),
    });

    const runsStore = createRuns(stack.db, createBudget(stack.db, limits), 150_000);
    await deleteInactiveThreads(stack.agent, runsStore, 90);

    const status = async (id: string) => (await user.request(`/v1/threads/${id}`)).status;
    expect([await status(old.id), await status(busy.id), await status(recent.id)]).toEqual([
      404, 200, 200,
    ]);
  });
});
