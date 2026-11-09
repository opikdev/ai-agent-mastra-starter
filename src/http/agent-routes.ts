import type { MastraDBMessage, StorageThreadType } from '@mastra/core/memory';
import type { ChunkType } from '@mastra/core/stream';
import type { Context, MiddlewareHandler } from 'hono';
import { Hono } from 'hono';
import { type SSEStreamingApi, streamSSE } from 'hono/streaming';
import { z } from 'zod';
import type { Budget, Usage } from '../agent/budget.ts';
import { type RunLimits, runOptions } from '../agent/context.ts';
import type { Assistant } from '../agent/mastra.ts';
import { type RelayResult, relay } from '../agent/relay.ts';
import type { Run, Runs } from '../agent/runs.ts';
import type { Logger } from '../platform/logger.ts';
import { ProblemError } from '../platform/problem.ts';
import type { AppEnv } from './env.ts';
import { internalError } from './error-handler.ts';
import { fromPublicId, newThreadId, toPublicId } from './ids.ts';
import { jsonBody, query } from './validate.ts';

export interface AgentLimits extends RunLimits {
  runTimeoutMs: number;
}

interface AgentRoutesOptions {
  agent: Assistant;
  runs: Runs;
  budget: Budget;
  logger: Logger;
  limits: AgentLimits;
  requireAuth: MiddlewareHandler<AppEnv>;
  agentRateLimit: MiddlewareHandler<AppEnv>;
  /** Aborts every open run when the process shuts down, so none stays marked running. */
  shutdownSignal: AbortSignal;
}

const threadIdPattern = /^thr_[0-9a-f]{32}$/;
const maxMessageLength = 8000;
const maxHistory = 100;

const createThreadSchema = z.strictObject({
  title: z.string().trim().min(1).max(200).optional(),
});

const listSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z
    .string()
    .regex(/^[1-9][0-9]{0,5}$/, 'must be meta.nextCursor from a previous page')
    .optional(),
});

const messageSchema = z.strictObject({
  content: z.string().trim().min(1).max(maxMessageLength),
});

const approvalSchema = z.strictObject({
  toolCallId: z.string().min(1).max(200),
  approved: z.boolean(),
  reason: z.string().trim().min(1).max(1000).optional(),
});

function presentThread(thread: StorageThreadType) {
  return {
    id: thread.id,
    title: thread.title || null,
    createdAt: thread.createdAt.toISOString(),
    updatedAt: thread.updatedAt.toISOString(),
  };
}

function presentMessage(message: MastraDBMessage) {
  const { parts } = message.content;
  const text = parts.map((part) => (part.type === 'text' ? part.text : '')).join('');
  const toolCalls = parts.flatMap((part) =>
    part.type === 'tool-invocation'
      ? [
          {
            toolCallId: part.toolInvocation.toolCallId,
            toolName: part.toolInvocation.toolName,
            args: part.toolInvocation.args,
            result: part.toolInvocation.result ?? null,
          },
        ]
      : [],
  );
  return {
    id: message.id,
    role: message.role,
    text,
    toolCalls,
    createdAt: message.createdAt.toISOString(),
  };
}

function threadNotFound(id: string) {
  return new ProblemError('not-found', `Thread ${id} does not exist.`);
}

export function createAgentRoutes({
  agent,
  runs,
  budget,
  logger,
  limits,
  requireAuth,
  agentRateLimit,
  shutdownSignal,
}: AgentRoutesOptions) {
  const app = new Hono<AppEnv>();
  app.use('*', requireAuth);

  async function memory() {
    const store = await agent.getMemory();
    if (!store) throw new Error('The agent has no memory configured.');
    return store;
  }

  /** Someone else's thread looks exactly like one that doesn't exist. */
  async function ownThread(userId: string, id: string): Promise<StorageThreadType> {
    if (!threadIdPattern.test(id)) throw threadNotFound(id);
    const thread = await (await memory()).getThreadById({ threadId: id });
    if (!thread || thread.resourceId !== userId) throw threadNotFound(id);
    return thread;
  }

  function failure(result: RelayResult, requestId: string, timedOut: boolean): ProblemError {
    if (shutdownSignal.aborted) {
      return new ProblemError(
        'service-unavailable',
        'The server shut down during this run. Send your message again.',
      );
    }
    if (timedOut) {
      return new ProblemError(
        'service-unavailable',
        `The agent didn't finish within ${limits.runTimeoutMs / 1000} seconds. Send a shorter or simpler request.`,
      );
    }
    if (result.status === 'failed' && result.error !== undefined) {
      logger.error({ err: result.error, requestId }, 'Agent run failed');
      return new ProblemError(
        'service-unavailable',
        `The model provider failed. Retry shortly, and quote request ${requestId} if it persists.`,
      );
    }
    return internalError(requestId);
  }

  /** Streams one agent turn as server-sent events and settles the run row when it ends. */
  function streamRun(
    c: Context<AppEnv>,
    run: Run,
    start: (signal: AbortSignal) => Promise<{ fullStream: AsyncIterable<ChunkType<undefined>> }>,
  ) {
    const user = c.get('user');
    const requestId = c.get('requestId');
    const runId = toPublicId('run', run.id);
    const spent: Usage = { inputTokens: 0, outputTokens: 0 };

    return streamSSE(
      c,
      async (stream: SSEStreamingApi) => {
        const disconnected = new AbortController();
        stream.onAbort(() => disconnected.abort());
        const timeout = AbortSignal.timeout(limits.runTimeoutMs);
        const signal = AbortSignal.any([disconnected.signal, timeout, shutdownSignal]);
        const heartbeat = setInterval(() => {
          runs.touch(run.id).catch((err) => logger.warn({ err, requestId }, 'Run touch failed'));
        }, 10_000);

        const send = (event: string, data: unknown) =>
          stream.writeSSE({ event, data: JSON.stringify(data) });

        let result: RelayResult;
        try {
          await send('run', { runId, threadId: run.threadId });
          const output = await start(signal);
          result = await relay(output.fullStream, {
            send: ({ event, data }) => send(event, data),
            record: async (usage) => {
              spent.inputTokens += usage.inputTokens;
              spent.outputTokens += usage.outputTokens;
              await budget.record(user.userId, usage);
            },
            onToolError: (err) => logger.error({ err, requestId, runId }, 'Tool failed'),
          });
        } catch (error) {
          result = { status: 'failed', error };
        } finally {
          clearInterval(heartbeat);
        }

        if (result.status === 'awaiting_approval' && result.pending) {
          await runs.await(run.id, result.pending);
          await send('approval-required', { runId, ...result.pending });
        } else {
          const final = result.status === 'aborted' ? 'failed' : result.status;
          await runs.finish(run.id, final === 'awaiting_approval' ? 'failed' : final);
        }

        if (result.status === 'failed' || result.status === 'aborted') {
          if (disconnected.signal.aborted) return;
          const problem = failure(result, requestId, timeout.aborted);
          await send('error', problem.toProblem(c.req.path));
        }
        await send('done', { runId, status: result.status, usage: spent });
      },
      async (error, stream) => {
        logger.error({ err: error, requestId, runId }, 'Streaming failed');
        await runs.finish(run.id, 'failed').catch(() => {});
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify(internalError(requestId).toProblem(c.req.path)),
        });
      },
    );
  }

  app.post('/threads', async (c) => {
    const { title } = await jsonBody(c, createThreadSchema);
    const thread = await (await memory()).createThread({
      threadId: newThreadId(),
      resourceId: c.get('user').userId,
      title: title ?? '',
    });
    c.header('Location', `/v1/threads/${thread.id}`);
    return c.json(presentThread(thread), 201);
  });

  app.get('/threads', async (c) => {
    const { limit, cursor } = query(c, listSchema);
    const page = cursor ? Number(cursor) : 0;
    const result = await (await memory()).listThreads({
      filter: { resourceId: c.get('user').userId },
      page,
      perPage: limit,
      orderBy: { field: 'updatedAt', direction: 'DESC' },
    });
    return c.json({
      data: result.threads.map(presentThread),
      meta: { limit, nextCursor: result.hasMore ? String(page + 1) : null },
    });
  });

  app.get('/threads/:id', async (c) => {
    const user = c.get('user');
    const thread = await ownThread(user.userId, c.req.param('id'));
    const { messages } = await (await memory()).recall({
      threadId: thread.id,
      resourceId: user.userId,
      perPage: maxHistory,
    });
    return c.json({
      ...presentThread(thread),
      messages: messages.map(presentMessage),
    });
  });

  app.delete('/threads/:id', async (c) => {
    const user = c.get('user');
    const thread = await ownThread(user.userId, c.req.param('id'));
    await runs.closeThread(thread.id);
    await (await memory()).deleteThread(thread.id);
    return c.body(null, 204);
  });

  app.post('/threads/:id/messages', agentRateLimit, async (c) => {
    const user = c.get('user');
    const thread = await ownThread(user.userId, c.req.param('id'));
    const { content } = await jsonBody(c, messageSchema);
    await budget.check(user.userId);
    const run = await runs.start(user.userId, thread.id);
    return streamRun(c, run, (signal) =>
      agent.stream(content, {
        runId: run.id,
        ...runOptions({ context: user, threadId: thread.id, limits, abortSignal: signal }),
      }),
    );
  });

  app.post('/runs/:id/approval', agentRateLimit, async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');
    const runUuid = fromPublicId('run', id);
    const run = runUuid ? await runs.find(user.userId, runUuid) : undefined;
    if (!run) throw new ProblemError('not-found', `Run ${id} does not exist.`);
    const { toolCallId, approved, reason } = await jsonBody(c, approvalSchema);
    await budget.check(user.userId);
    if (!(await runs.claimApproval(run, toolCallId))) {
      throw new ProblemError(
        'approval-not-pending',
        `Run ${id} isn't waiting for approval of tool call ${toolCallId}.`,
      );
    }
    return streamRun(c, run, (signal) => {
      const options = {
        runId: run.id,
        toolCallId,
        ...runOptions({ context: user, threadId: run.threadId, limits, abortSignal: signal }),
      };
      return approved
        ? agent.approveToolCall(options)
        : agent.declineToolCall({ ...options, ...(reason ? { reason } : {}) });
    });
  });

  app.get('/usage', async (c) => {
    const used = await budget.used(c.get('user').userId);
    const total = used.inputTokens + used.outputTokens;
    return c.json({
      ...used,
      dailyBudget: budget.dailyTokens,
      remaining: Math.max(0, budget.dailyTokens - total),
    });
  });

  return app;
}
