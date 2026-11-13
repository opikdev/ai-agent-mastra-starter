# API

Every `/v1` route needs `Authorization: Bearer <token>`, where the token comes from the [notes API](notes-api.md#auth). The scheme is case-insensitive. Errors are [Problem Details](errors.md). With `DOCS_ENABLED=true`, as in Compose, the OpenAPI 3.1 document is at `/openapi.json` and Swagger UI at `/docs`. `openapi.json` in the repo holds the same document.

| Method | Path | Does |
|---|---|---|
| `POST` | `/v1/threads` | Starts a thread. Body: `{ "title"?: string }` |
| `GET` | `/v1/threads?limit&cursor` | Lists your threads, most recently updated first |
| `GET` | `/v1/threads/{id}` | Gets a thread and its latest 100 messages |
| `DELETE` | `/v1/threads/{id}` | Deletes a thread and its messages |
| `POST` | `/v1/threads/{id}/messages` | Sends a message and streams the reply. Body: `{ "content": string }`. Takes an optional [`Idempotency-Key`](#retry-safely) |
| `POST` | `/v1/runs/{id}/approval` | Approves or declines a paused tool call and streams the rest. Body: `{ "toolCallId": string, "approved": boolean, "reason"?: string }` |
| `GET` | `/v1/usage` | Shows today's tokens and budget: the [usage](#usage) fields plus `dailyBudget`, `reserved`, and `remaining` |
| `GET` | `/healthz` | Liveness |
| `GET` | `/readyz` | Readiness: Postgres is reachable and the server isn't shutting down |

`limit` is 1 to 100, 20 by default. Pass `meta.nextCursor` as `cursor` for the next page. Messages are 1 to 8,000 characters.

## Headers

Every `/v1` response has `Cache-Control: no-store`, and every response has `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`, except `/docs`, which has its own policy.

Rate limits follow [draft-ietf-httpapi-ratelimit-headers](https://datatracker.ietf.org/doc/draft-ietf-httpapi-ratelimit-headers/):

| Header | Example | Holds |
|---|---|---|
| `RateLimit-Policy` | `"global";q=300;w=60, "agent";q=20;w=60` | Each policy that applies: its quota, `q`, and window in seconds, `w` |
| `RateLimit` | `"global";r=298;t=41, "agent";r=19;t=41` | What's left of each, `r`, and the seconds until it resets, `t` |

On a 429 from a rate limit, `RateLimit` names only the policy that was exceeded, and `Retry-After` equals its `t`. The `global` policy counts each client network: an IPv4 address, or an IPv6 /64. The `agent` policy, on messages and approvals, counts each user.

## Stream events

Message and approval responses are `text/event-stream`. Each event's `data` is JSON:

| Event | Data | When |
|---|---|---|
| `run` | `{ runId, threadId }` | First, always |
| `text` | `{ delta }` | Each piece of the reply |
| `tool-call` | `{ toolCallId, toolName, args }` | The model calls a tool |
| `tool-result` | `{ toolCallId, toolName, result }` | A tool returns. A failure the model can act on is `{ error }` |
| `tool-error` | `{ toolCallId, toolName, detail }` | A tool crashed. The model is told and may try another way |
| `approval-required` | `{ runId, toolCallId, toolName, args }` | A tool waits for approval. It comes just before `done` |
| `blocked` | `{ reason }` | A guardrail blocked the message |
| `error` | A Problem Details object | The run failed |
| `done` | `{ runId, status, reason, usage }`, with the run's [usage](#usage) | Last, unless the client disconnected |

## How a run ends

`done` says how the run ended in `status`, and why it stopped short in `reason`, which is `null` otherwise. A client should show anything but `completed` as unfinished:

| `status` | `reason` | Means |
|---|---|---|
| `completed` | `null` | The model finished its answer |
| `incomplete` | `max_tokens` | The model hit `AGENT_MAX_OUTPUT_TOKENS` mid-answer, so the reply is cut off |
| `incomplete` | `context_window` | The conversation filled the model's context window |
| `incomplete` | `max_steps` | The run used its `AGENT_MAX_STEPS` model calls before answering |
| `incomplete` | `token_limit` | The next step could have spent more than the run's `AGENT_RUN_TOKEN_LIMIT` |
| `refused` | `refusal` | The model declined to answer |
| `awaiting_approval` | `null` | A tool waits for [approval](#approve-a-tool-call) |
| `blocked` | `null` | The guardrail flagged the message. A `blocked` event comes first |
| `failed` | `guardrail_unavailable` | The prompt injection check failed, and `GUARDRAIL_ON_ERROR` is `block` |
| `failed` | `model_error`, `error` | The model provider or the server failed. An `error` event comes first |
| `aborted` | `timeout`, `shutdown` | The run hit `AGENT_RUN_TIMEOUT_MS`, or the server shut down. An `error` event comes first |

The run's row in Postgres keeps the same status and reason, except that an aborted run is saved as `failed`. An `incomplete` or `refused` run frees its thread like a completed one, so the user can ask again.

## Usage

Usage counts tokens from every model call, split by the model's role:

| Field | Holds |
|---|---|
| `inputTokens`, `outputTokens` | Totals across the agent and the guardrail. The budget counts these. Input includes cached tokens |
| `cacheReadInputTokens`, `cacheWriteInputTokens` | How much of the input was read from, or written to, the prompt cache |
| `agent` | The same four fields for the agent's model |
| `guardrail` | The same four fields for the prompt injection check. Zero when `GUARDRAIL_MODEL` is `off` |

`GET /v1/usage` adds `dailyBudget`, `reserved`, the tokens your streaming runs hold, and `remaining`, which is the budget minus both. A run needs `AGENT_RUN_TOKEN_LIMIT` tokens free to start, and `AGENT_MAX_CONCURRENT_RUNS` caps how many of yours stream at once, as [Costs](operations.md#costs) explains.

Every 10 seconds, the stream also sends a `: keepalive` comment, so proxies don't close it while the model thinks. SSE clients ignore comments.

## Retry safely

Send `Idempotency-Key` with a message, such as a UUID, so a retry after a dropped connection can't send it twice. For 24 hours, a request with the same key and body returns `409 duplicate-request` with the `runId` it started, instead of starting another run. Read the reply with `GET /v1/threads/{id}`. The same key with a different body or thread returns `422 idempotency-key-reused`. A request that fails before its run starts, such as with `409 thread-busy`, doesn't use up its key.

## Approve a tool call

When an `approval-required` event arrives, show the user `toolName` and `args`, then send the decision. The run is already saved as waiting, so you can send it right away, before `done` arrives:

```sh
curl -N -X POST localhost:3000/v1/runs/$RUN_ID/approval -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"toolCallId":"'$TOOL_CALL_ID'","approved":true}'
```

To decline, send `"approved": false` and an optional `reason`. The model sees the reason and answers the user.

A paused run holds no tokens. Approving reserves them again, so it can return `429 budget-exceeded` or `429 too-many-runs` like a new message. Until you decide, new messages on that thread return `409 approval-pending`. An approval left for `APPROVAL_TTL_HOURS`, 24 by default, expires within the next hour: its run fails and the thread takes messages again. Each approval runs once: a second one returns `409 approval-not-pending`.

## Read the stream in TypeScript

```ts
const response = await fetch(`${baseUrl}/v1/threads/${threadId}/messages`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ content: 'What notes do I have?' }),
});
if (!response.ok) throw new Error((await response.json()).detail);

const decoder = new TextDecoder();
let buffer = '';
for await (const bytes of response.body!) {
  buffer += decoder.decode(bytes, { stream: true });
  const frames = buffer.split('\n\n');
  buffer = frames.pop() ?? '';
  for (const frame of frames) {
    const event = frame.match(/^event: (.*)$/m)?.[1];
    const data = JSON.parse(frame.match(/^data: (.*)$/m)?.[1] ?? 'null');
    if (event === 'text') process.stdout.write(data.delta);
    if (event === 'approval-required') console.log('\nApprove?', data.toolName, data.args);
  }
}
```
