import { createRoute, z } from '@hono/zod-openapi';
import type { MastraDBMessage, StorageThreadType } from '@mastra/core/memory';
import type { ChunkType } from '@mastra/core/stream';
import { isSpanContextValid, trace } from '@opentelemetry/api';
import type { Context, MiddlewareHandler } from 'hono';
import { type SSEStreamingApi, streamSSE } from 'hono/streaming';
import {
  addUsage,
  type Budget,
  noUsage,
  summarize,
  tokensOf,
  type Usage,
  type UsageRole,
} from '../agent/budget.ts';
import {
  type GuardrailMonitor,
  type RunLimits,
  runOptions,
  type StopCondition,
} from '../agent/context.ts';
import type { Assistant } from '../agent/mastra.ts';
import { type Outcome, outcomeOf, type RelayResult, relay, stepUsage } from '../agent/relay.ts';
import type { Run, Runs } from '../agent/runs.ts';
import type { Logger } from '../platform/logger.ts';
import type { RunMetrics } from '../platform/metrics.ts';
import { ProblemError } from '../platform/problem.ts';
import { fromPublicId, newThreadId, toPublicId } from '../platform/public-id.ts';
import { internalError } from './error-handler.ts';
import { idempotencyOf } from './idempotency.ts';
import { headerRefs, problemResponses } from './openapi.ts';
import { type AppEnv, createRouter } from './router.ts';

export interface AgentLimits extends RunLimits {
  runTimeoutMs: number;
}

interface AgentRoutesOptions {
  agent: Assistant;
  runs: Runs;
  budget: Budget;
  logger: Logger;
  metrics: RunMetrics;
  limits: AgentLimits;
  /** Whether trace spans may hold prompts, replies, and tool data. */
  recordContent: boolean;
  requireAuth: MiddlewareHandler<AppEnv>;
  agentRateLimit: MiddlewareHandler<AppEnv>;
  /** Aborts every open run when the process shuts down, so none stays marked running. */
  shutdownSignal: AbortSignal;
}

const threadIdPattern = /^thr_[0-9a-f]{32}$/;
const maxMessageLength = 8000;
const maxHistory = 100;
const heartbeatMs = 10_000;
const security = [{ bearerAuth: [] }];

const threadSchema = z
  .object({
    id: z.string().openapi({ example: 'thr_0190a7e4c1f07c3e8d21b6f4a9e05d13' }),
    title: z.string().nullable().openapi({ example: 'Weekly plan' }),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .openapi('Thread');

const messageSchema = z
  .object({
    id: z.string(),
    role: z.enum(['user', 'assistant', 'system', 'signal']),
    text: z.string(),
    toolCalls: z.array(
      z.object({
        toolCallId: z.string(),
        toolName: z.string(),
        args: z.unknown(),
        result: z.unknown(),
      }),
    ),
    createdAt: z.iso.datetime(),
  })
  .openapi('Message');

const threadWithMessagesSchema = threadSchema
  .extend({ messages: z.array(messageSchema) })
  .openapi('ThreadWithMessages');

const threadPageSchema = z
  .object({
    data: z.array(threadSchema),
    meta: z.object({ limit: z.number().int(), nextCursor: z.string().nullable() }),
  })
  .openapi('ThreadList');

const usageSchema = z.object({
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  cacheReadInputTokens: z.number().int(),
  cacheWriteInputTokens: z.number().int(),
});

const runUsageSchema = usageSchema
  .extend({ agent: usageSchema, guardrail: usageSchema })
  .openapi('Usage');

const dailyUsageSchema = runUsageSchema
  .extend({
    dailyBudget: z.number().int(),
    reserved: z.number().int().openapi({ description: 'Tokens held by runs still streaming' }),
    remaining: z.number().int(),
  })
  .openapi('DailyUsage');

const createThreadSchema = z
  .strictObject({ title: z.string().trim().min(1).max(200).optional() })
  .openapi('CreateThread');

const listSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z
    .string()
    .regex(/^[1-9][0-9]{0,5}$/, 'must be meta.nextCursor from a previous page')
    .optional()
    .openapi({ description: '`meta.nextCursor` from a previous page.' }),
});

const sendMessageSchema = z
  .strictObject({ content: z.string().trim().min(1).max(maxMessageLength) })
  .openapi('SendMessage');

const approvalSchema = z
  .strictObject({
    toolCallId: z.string().min(1).max(200),
    approved: z.boolean(),
    reason: z.string().trim().min(1).max(1000).optional(),
  })
  .openapi('Approval');

const idParams = (example: string) =>
  z.object({ id: z.string().openapi({ param: { name: 'id', in: 'path' }, example }) });

const idempotencyHeaders = z.object({
  'idempotency-key': z.string().min(1).max(255).optional().openapi({
    description:
      'Repeating a request with the same key within 24 hours returns `409 duplicate-request` with the run it started and its status, instead of sending the message twice. A run that fails before the agent calls a tool frees its key, so a retry with it runs again.',
  }),
});

const eventStream = {
  description:
    'Server-sent events: `run`, then `text`, `tool-call`, `tool-result`, `tool-error`, `approval-required`, `blocked`, or `error`, then `done`. See docs/api.md.',
  content: { 'text/event-stream': { schema: z.string().openapi({ format: 'event-stream' }) } },
};

const json = <T extends z.ZodType>(schema: T) => ({ content: { 'application/json': { schema } } });

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

/** The request's span, so the run's Mastra spans join its trace. */
function activeTrace() {
  const context = trace.getActiveSpan()?.spanContext();
  return context && isSpanContextValid(context)
    ? { traceId: context.traceId, parentSpanId: context.spanId }
    : {};
}

type StartRun = (
  signal: AbortSignal,
  options: {
    onStepFinish: ReturnType<typeof stepUsage>;
    guardrailMonitor: GuardrailMonitor;
    stopWhen: StopCondition;
  },
) => Promise<{ fullStream: AsyncIterable<ChunkType<undefined>> }>;

export function createAgentRoutes({
  agent,
  runs,
  budget,
  logger,
  metrics,
  limits,
  recordContent,
  requireAuth,
  agentRateLimit,
  shutdownSignal,
}: AgentRoutesOptions) {
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

  function failure(outcome: Outcome, result: RelayResult, requestId: string): ProblemError {
    switch (outcome.reason) {
      case 'shutdown':
        return new ProblemError(
          'service-unavailable',
          'The server shut down during this run. Send your message again.',
        );
      case 'timeout':
        return new ProblemError(
          'service-unavailable',
          `The agent didn't finish within ${limits.runTimeoutMs / 1000} seconds. Send a shorter or simpler request.`,
        );
      case 'guardrail_unavailable':
        return new ProblemError(
          'service-unavailable',
          "The safety check couldn't run, so the agent didn't read your message. Retry shortly.",
          { headers: { 'Retry-After': '5' } },
        );
      case 'model_error':
        logger.error({ err: result.error, requestId }, 'Agent run failed');
        return new ProblemError(
          'service-unavailable',
          `The model provider failed. Retry shortly, and quote request ${requestId} if it persists.`,
        );
      default:
        return internalError(requestId);
    }
  }

  /**
   * Streams one segment of a run, up to its end or its next approval, as server-sent events, and
   * settles the run row when it ends. The segment may spend what the run reserved for it.
   */
  function streamRun(c: Context<AppEnv>, run: Run, resumed: boolean, start: StartRun) {
    const user = c.get('user');
    const requestId = c.get('requestId');
    const runId = toPublicId('run', run.id);
    const startedAt = performance.now();
    const spent = noUsage();
    const save = async (role: UsageRole, usage: Usage) => {
      metrics.tokens(role, usage.inputTokens, usage.outputTokens);
      await budget.spend(run.id, user.userId, role, usage);
    };
    const recordAgent = async (usage: Usage) => {
      addUsage(spent.agent, usage);
      await save('agent', usage);
    };
    let guardrailFailed = false;
    // Saved once the run ends, so a database error can't fail the check.
    const guardrailMonitor: GuardrailMonitor = {
      record: (usage) => addUsage(spent.guardrail, usage),
      failed: () => {
        guardrailFailed = true;
      },
    };
    let tokenLimitReached = false;
    /**
     * Stops before a step that could take the segment past its reservation. A resumed segment
     * starts by repeating the paused step, whose tokens the run already spent.
     */
    const stopWhen: StopCondition = ({ steps }) => {
      const agentTokens = steps
        .slice(resumed ? 1 : 0)
        .reduce(
          (sum, step) => sum + (step.usage.inputTokens ?? 0) + (step.usage.outputTokens ?? 0),
          0,
        );
      const last = steps.at(-1)?.usage;
      const nextStep =
        (last?.inputTokens ?? 0) + (last?.outputTokens ?? 0) + limits.maxOutputTokens;
      tokenLimitReached = agentTokens + tokensOf(spent.guardrail) + nextStep > run.reservedTokens;
      return tokenLimitReached;
    };
    // A run that stops before any tool could act frees its Idempotency-Key, so a retry runs.
    let toolCalled = resumed;

    return streamSSE(
      c,
      async (stream: SSEStreamingApi) => {
        const disconnected = new AbortController();
        stream.onAbort(() => disconnected.abort());
        const timeout = AbortSignal.timeout(limits.runTimeoutMs);
        const signal = AbortSignal.any([disconnected.signal, timeout, shutdownSignal]);
        const heartbeat = setInterval(() => {
          void stream.write(': keepalive\n\n');
          runs.touch(run.id).catch((err) => logger.warn({ err, requestId }, 'Run touch failed'));
        }, heartbeatMs);

        const send = (event: string, data: unknown) =>
          stream.writeSSE({ event, data: JSON.stringify(data) });

        let result: RelayResult;
        try {
          await send('run', { runId, threadId: run.threadId });
          const output = await start(signal, {
            onStepFinish: stepUsage(recordAgent, { resumed }),
            guardrailMonitor,
            stopWhen,
          });
          result = await relay(output.fullStream, {
            send: ({ event, data }) => {
              if (event === 'tool-call') toolCalled = true;
              return send(event, data);
            },
            record: recordAgent,
            onToolError: (err) => logger.error({ err, requestId, runId }, 'Tool failed'),
          });
        } catch (error) {
          result = { status: 'failed', error };
        } finally {
          clearInterval(heartbeat);
        }
        await save('guardrail', spent.guardrail);

        let outcome = outcomeOf(result, { tokenLimitReached });
        if (outcome.status === 'blocked' && guardrailFailed) {
          outcome = { status: 'failed', reason: 'guardrail_unavailable' };
        } else if (outcome.status === 'aborted') {
          const reason = shutdownSignal.aborted
            ? 'shutdown'
            : timeout.aborted
              ? 'timeout'
              : 'disconnected';
          outcome = { status: 'aborted', reason };
        } else if (outcome.status === 'failed') {
          outcome = {
            status: 'failed',
            reason: result.error === undefined ? 'error' : 'model_error',
          };
        }
        if (guardrailFailed) {
          const action = outcome.reason === 'guardrail_unavailable' ? 'block' : 'allow';
          logger.warn(
            { event: 'guardrail.failed', action, requestId, runId },
            'The prompt injection check failed',
          );
        }

        if (outcome.status === 'awaiting_approval' && result.pending) {
          await runs.await(run.id, result.pending);
          await send('approval-required', { runId, ...result.pending });
        } else if (outcome.status === 'aborted' || outcome.status === 'failed') {
          await runs.finish(run.id, 'failed', outcome.reason ?? 'error', {
            releaseKey: !toolCalled,
          });
        } else if (outcome.status === 'awaiting_approval') {
          await runs.finish(run.id, 'failed', 'error');
        } else {
          await runs.finish(run.id, outcome.status, outcome.reason);
        }
        metrics.run(outcome.status, outcome.reason, (performance.now() - startedAt) / 1000);

        if (outcome.status === 'blocked') {
          await send('blocked', { reason: result.blockReason ?? 'The guardrail blocked it.' });
        }
        if (outcome.status === 'failed' || outcome.status === 'aborted') {
          if (disconnected.signal.aborted) return;
          await send('error', failure(outcome, result, requestId).toProblem(c.req.path));
        }
        await send('done', {
          runId,
          status: outcome.status,
          reason: outcome.reason,
          usage: summarize(spent),
        });
      },
      async (error, stream) => {
        logger.error({ err: error, requestId, runId }, 'Streaming failed');
        await runs
          .finish(run.id, 'failed', 'error', { releaseKey: !toolCalled })
          .catch((err) => logger.error({ err, requestId, runId }, 'Run finish failed'));
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify(internalError(requestId).toProblem(c.req.path)),
        });
      },
    );
  }

  /** Streams the end of a run that stopped before it could resume. */
  function endedRun(c: Context<AppEnv>, run: Run, problem: ProblemError) {
    const runId = toPublicId('run', run.id);
    metrics.run('failed', run.stopReason, 0);
    return streamSSE(c, async (stream) => {
      const send = (event: string, data: unknown) =>
        stream.writeSSE({ event, data: JSON.stringify(data) });
      await send('run', { runId, threadId: run.threadId });
      await send('error', problem.toProblem(c.req.path));
      await send('done', {
        runId,
        status: run.status,
        reason: run.stopReason,
        usage: summarize(noUsage()),
      });
    });
  }

  const tracing = () => ({ recordContent, ...activeTrace() });

  return createRouter()
    .openapi(
      createRoute({
        method: 'post',
        path: '/threads',
        operationId: 'createThread',
        summary: 'Start a thread',
        tags: ['Threads'],
        security,
        middleware: [requireAuth],
        request: { body: { ...json(createThreadSchema), required: true } },
        responses: {
          201: {
            description: 'Thread created',
            headers: headerRefs('Location'),
            ...json(threadSchema),
          },
          ...problemResponses('validation-failed'),
        },
      }),
      async (c) => {
        const { title } = c.req.valid('json');
        const thread = await (await memory()).createThread({
          threadId: newThreadId(),
          resourceId: c.get('user').userId,
          title: title ?? '',
        });
        c.header('Location', `/v1/threads/${thread.id}`);
        return c.json(presentThread(thread), 201);
      },
    )
    .openapi(
      createRoute({
        method: 'get',
        path: '/threads',
        operationId: 'listThreads',
        summary: 'List your threads, most recently updated first',
        tags: ['Threads'],
        security,
        middleware: [requireAuth],
        request: { query: listSchema },
        responses: {
          200: { description: 'A page of threads', ...json(threadPageSchema) },
          ...problemResponses('validation-failed'),
        },
      }),
      async (c) => {
        const { limit, cursor } = c.req.valid('query');
        const page = cursor ? Number(cursor) : 0;
        const result = await (await memory()).listThreads({
          filter: { resourceId: c.get('user').userId },
          page,
          perPage: limit,
          orderBy: { field: 'updatedAt', direction: 'DESC' },
        });
        return c.json(
          {
            data: result.threads.map(presentThread),
            meta: { limit, nextCursor: result.hasMore ? String(page + 1) : null },
          },
          200,
        );
      },
    )
    .openapi(
      createRoute({
        method: 'get',
        path: '/threads/{id}',
        operationId: 'getThread',
        summary: 'Get a thread and its latest 100 messages',
        tags: ['Threads'],
        security,
        middleware: [requireAuth],
        request: { params: idParams('thr_0190a7e4c1f07c3e8d21b6f4a9e05d13') },
        responses: {
          200: { description: 'The thread', ...json(threadWithMessagesSchema) },
          ...problemResponses('not-found'),
        },
      }),
      async (c) => {
        const user = c.get('user');
        const thread = await ownThread(user.userId, c.req.valid('param').id);
        const { messages } = await (await memory()).recall({
          threadId: thread.id,
          resourceId: user.userId,
          perPage: maxHistory,
        });
        return c.json({ ...presentThread(thread), messages: messages.map(presentMessage) }, 200);
      },
    )
    .openapi(
      createRoute({
        method: 'delete',
        path: '/threads/{id}',
        operationId: 'deleteThread',
        summary: 'Delete a thread and its messages',
        tags: ['Threads'],
        security,
        middleware: [requireAuth],
        request: { params: idParams('thr_0190a7e4c1f07c3e8d21b6f4a9e05d13') },
        responses: {
          204: { description: 'Deleted' },
          ...problemResponses('not-found', 'thread-busy'),
        },
      }),
      async (c) => {
        const thread = await ownThread(c.get('user').userId, c.req.valid('param').id);
        await runs.closeThread(thread.id);
        await (await memory()).deleteThread(thread.id);
        return c.body(null, 204);
      },
    )
    .openapi(
      createRoute({
        method: 'post',
        path: '/threads/{id}/messages',
        operationId: 'sendMessage',
        summary: 'Send a message and stream the reply',
        tags: ['Runs'],
        security,
        middleware: [requireAuth, agentRateLimit],
        request: {
          params: idParams('thr_0190a7e4c1f07c3e8d21b6f4a9e05d13'),
          headers: idempotencyHeaders,
          body: { ...json(sendMessageSchema), required: true },
        },
        responses: {
          200: eventStream,
          ...problemResponses(
            'validation-failed',
            'not-found',
            'thread-busy',
            'idempotency-key-reused',
            'budget-exceeded',
          ),
        },
      }),
      async (c) => {
        const user = c.get('user');
        const thread = await ownThread(user.userId, c.req.valid('param').id);
        const body = c.req.valid('json');
        const idempotency = idempotencyOf(c, c.req.valid('header')['idempotency-key'], body);
        const run = await runs.start(user.userId, thread.id, idempotency);
        return streamRun(c, run, false, (signal, options) =>
          agent.stream(body.content, {
            runId: run.id,
            onStepFinish: options.onStepFinish,
            ...runOptions({
              context: user,
              threadId: thread.id,
              limits,
              tracing: tracing(),
              abortSignal: signal,
              guardrailMonitor: options.guardrailMonitor,
              stopWhen: options.stopWhen,
            }),
          }),
        ) as never;
      },
    )
    .openapi(
      createRoute({
        method: 'post',
        path: '/runs/{id}/approval',
        operationId: 'decideApproval',
        summary: 'Approve or decline a paused tool call and stream the rest of the run',
        tags: ['Runs'],
        security,
        middleware: [requireAuth, agentRateLimit],
        request: {
          params: idParams('run_0190a7e4c1f07c3e8d21b6f4a9e05d13'),
          body: { ...json(approvalSchema), required: true },
        },
        responses: {
          200: eventStream,
          ...problemResponses('validation-failed', 'not-found', 'approval-not-pending'),
        },
      }),
      async (c) => {
        const user = c.get('user');
        const id = c.req.valid('param').id;
        const runUuid = fromPublicId('run', id);
        const run = runUuid ? await runs.find(user.userId, runUuid) : undefined;
        if (!run) throw new ProblemError('not-found', `Run ${id} does not exist.`);
        const { toolCallId, approved, reason } = c.req.valid('json');
        const claim = await runs.claimApproval(run.id, toolCallId);
        if (!claim) {
          throw new ProblemError(
            'approval-not-pending',
            `Run ${id} isn't waiting for approval of tool call ${toolCallId}.`,
          );
        }
        if (claim.ended) {
          const outcome = approved
            ? `without calling ${claim.pending.toolName}`
            : 'without a reply';
          return endedRun(
            c,
            claim.run,
            new ProblemError(
              claim.ended.slug,
              `Run ${id} ended ${outcome}, and its thread takes messages again. ${claim.ended.message}`,
            ),
          ) as never;
        }
        return streamRun(c, claim.run, true, (signal, options) => {
          const resume = {
            runId: run.id,
            toolCallId,
            onStepFinish: options.onStepFinish,
            ...runOptions({
              context: user,
              threadId: run.threadId,
              limits,
              tracing: tracing(),
              abortSignal: signal,
              guardrailMonitor: options.guardrailMonitor,
              stopWhen: options.stopWhen,
            }),
          };
          return approved
            ? agent.approveToolCall(resume)
            : agent.declineToolCall({ ...resume, ...(reason ? { reason } : {}) });
        }) as never;
      },
    )
    .openapi(
      createRoute({
        method: 'get',
        path: '/usage',
        operationId: 'getUsage',
        summary: "Show today's tokens and budget",
        tags: ['Usage'],
        security,
        middleware: [requireAuth],
        responses: { 200: { description: "Today's usage", ...json(dailyUsageSchema) } },
      }),
      async (c) => {
        const userId = c.get('user').userId;
        const used = summarize(await budget.used(userId));
        const reserved = await budget.reserved(userId);
        return c.json(
          {
            ...used,
            dailyBudget: budget.dailyTokens,
            reserved,
            remaining: Math.max(0, budget.dailyTokens - tokensOf(used) - reserved),
          },
          200,
        );
      },
    );
}
