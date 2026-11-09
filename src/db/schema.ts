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
  'blocked',
  'failed',
] as const;
export type RunStatus = (typeof runStatuses)[number];

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
    pending: jsonb('pending').$type<PendingApproval>(),
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
    uniqueIndex('uq_runs_open_thread')
      .on(table.threadId)
      .where(sql`status in ('running', 'awaiting_approval')`),
  ],
);

/** Tokens each user spent per UTC day, checked against DAILY_TOKEN_BUDGET. */
export const tokenUsage = pgTable(
  'token_usage',
  {
    userId: text('user_id').notNull(),
    day: date('day').notNull(),
    inputTokens: bigint('input_tokens', { mode: 'number' }).notNull().default(0),
    outputTokens: bigint('output_tokens', { mode: 'number' }).notNull().default(0),
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
