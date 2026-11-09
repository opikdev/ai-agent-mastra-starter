# API

Every `/v1` route needs `Authorization: Bearer <token>`, where the token comes from the notes API. Errors are [Problem Details](errors.md).

| Method | Path | Does |
|---|---|---|
| `POST` | `/v1/threads` | Starts a thread. Body: `{ "title"?: string }` |
| `GET` | `/v1/threads?limit&cursor` | Lists your threads, most recently updated first |
| `GET` | `/v1/threads/{id}` | Gets a thread and its latest 100 messages |
| `DELETE` | `/v1/threads/{id}` | Deletes a thread and its messages |
| `POST` | `/v1/threads/{id}/messages` | Sends a message and streams the reply. Body: `{ "content": string }` |
| `POST` | `/v1/runs/{id}/approval` | Approves or declines a paused tool call and streams the rest. Body: `{ "toolCallId": string, "approved": boolean, "reason"?: string }` |
| `GET` | `/v1/usage` | Shows today's tokens and budget |
| `GET` | `/healthz` | Liveness |
| `GET` | `/readyz` | Readiness, including Postgres |

`limit` is 1 to 100, 20 by default. Pass `meta.nextCursor` as `cursor` for the next page. Messages are 1 to 8,000 characters.

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
| `done` | `{ runId, status, usage: { inputTokens, outputTokens } }` | Last, unless the client disconnected |

`status` is `completed`, `awaiting_approval`, `blocked`, `failed`, or `aborted`.

## Approve a tool call

When an `approval-required` event arrives, show the user `toolName` and `args`, then send the decision. The run is already saved as waiting, so you can send it right away, before `done` arrives:

```sh
curl -N -X POST localhost:3000/v1/runs/$RUN_ID/approval -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"toolCallId":"'$TOOL_CALL_ID'","approved":true}'
```

To decline, send `"approved": false` and an optional `reason`. The model sees the reason and answers the user.

Until you decide, new messages on that thread return `409 approval-pending`. Each approval runs once: a second one returns `409 approval-not-pending`.

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
