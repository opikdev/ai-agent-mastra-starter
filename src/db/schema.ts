import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const id = uuid('id').notNull().default(sql`uuidv7()`);

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

export const runStatuses = [
  'running',
  'awaiting_approval',
  'completed',
  'incomplete',
  'refused',
  'blocked',
  'failed',
] as const;
export type RunStatus = (typeof runStatuses)[number];

/** Why a run ended without a complete answer. Null for completed, blocked, and open runs. */
export const stopReasons = [
  'max_tokens',
  'context_window',
  'max_steps',
  'token_limit',
  'refusal',
  'timeout',
  'shutdown',
  'disconnected',
  'guardrail_unavailable',
  'model_error',
  'approval_expired',
  'budget_exceeded',
  'thread_deleted',
  'stale',
  'error',
] as const;
export type StopReason = (typeof stopReasons)[number];

export interface PendingApproval {
  toolCallId: string;
  toolName: string;
  args: unknown;
}

/** One agent run per row. A thread has at most one open run, so replies never interleave. */
export const runs = pgTable(
  'runs',
  {
    id,
    userId: text('user_id').notNull(),
    threadId: text('thread_id').notNull(),
    status: text('status').$type<RunStatus>().notNull().default('running'),
    stopReason: text('stop_reason').$type<StopReason>(),
    pending: jsonb('pending').$type<PendingApproval>(),
    /** Tokens held against the user's budget while the run streams. Zero once it settles. */
    reservedTokens: bigint('reserved_tokens', { mode: 'number' }).notNull().default(0),
    /** Tokens the run spent across all its segments, which AGENT_RUN_TOKEN_LIMIT caps. */
    spentTokens: bigint('spent_tokens', { mode: 'number' }).notNull().default(0),
    ...timestamps,
  },
  (table) => [
    primaryKey({ name: 'pk_runs', columns: [table.id] }),
    check(
      'chk_runs_status',
      sql.raw(`status in (${runStatuses.map((status) => `'${status}'`).join(', ')})`),
    ),
    check(
      'chk_runs_pending',
      sql`(${table.status} = 'awaiting_approval') = (${table.pending} is not null)`,
    ),
    check('chk_runs_reserved_tokens', sql`${table.reservedTokens} >= 0`),
    check('chk_runs_spent_tokens', sql`${table.spentTokens} >= 0`),
    uniqueIndex('uq_runs_open_thread')
      .on(table.threadId)
      .where(sql`status in ('running', 'awaiting_approval')`),
    // Serves the per-user count of streaming runs and the sum of their reservations.
    index('idx_runs_running_user').on(table.userId).where(sql`status = 'running'`),
  ],
);

/**
 * Tokens each user spent per UTC day, checked against DAILY_TOKEN_BUDGET. The input and output
 * totals count every model call. Input includes the cache columns, which say how much of it was
 * read from or written to the prompt cache. The guardrail columns hold the guardrail's share.
 */
export const tokenUsage = pgTable(
  'token_usage',
  {
    userId: text('user_id').notNull(),
    day: date('day').notNull(),
    inputTokens: bigint('input_tokens', { mode: 'number' }).notNull().default(0),
    outputTokens: bigint('output_tokens', { mode: 'number' }).notNull().default(0),
    guardrailInputTokens: bigint('guardrail_input_tokens', { mode: 'number' }).notNull().default(0),
    guardrailOutputTokens: bigint('guardrail_output_tokens', { mode: 'number' })
      .notNull()
      .default(0),
    cacheReadInputTokens: bigint('cache_read_input_tokens', { mode: 'number' })
      .notNull()
      .default(0),
    cacheWriteInputTokens: bigint('cache_write_input_tokens', { mode: 'number' })
      .notNull()
      .default(0),
    guardrailCacheReadInputTokens: bigint('guardrail_cache_read_input_tokens', { mode: 'number' })
      .notNull()
      .default(0),
    guardrailCacheWriteInputTokens: bigint('guardrail_cache_write_input_tokens', {
      mode: 'number',
    })
      .notNull()
      .default(0),
    ...timestamps,
  },
  (table) => [
    primaryKey({ name: 'pk_token_usage', columns: [table.userId, table.day] }),
    // Serves the retention cleanup, which deletes old days across all users.
    index('idx_token_usage_day').on(table.day),
  ],
);

export const rateLimits = pgTable(
  'rate_limits',
  {
    key: text('key').notNull(),
    count: integer('count').notNull().default(1),
    resetAt: timestamp('reset_at', { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (table) => [
    primaryKey({ name: 'pk_rate_limits', columns: [table.key] }),
    index('idx_rate_limits_reset_at').on(table.resetAt),
  ],
);

/** One row per Idempotency-Key a user sent to a run-starting endpoint, kept for 24 hours. */
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    id,
    userId: text('user_id').notNull(),
    endpoint: text('endpoint').notNull(),
    key: text('key').notNull(),
    requestHash: text('request_hash').notNull(),
    runId: uuid('run_id').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (table) => [
    primaryKey({ name: 'pk_idempotency_keys', columns: [table.id] }),
    uniqueIndex('uq_idempotency_keys_user_endpoint_key').on(
      table.userId,
      table.endpoint,
      table.key,
    ),
    index('idx_idempotency_keys_expires_at').on(table.expiresAt),
  ],
);
