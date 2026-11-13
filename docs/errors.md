# Errors

Every error is [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) Problem Details with `Content-Type: application/problem+json`. `type` is `urn:problem:<slug>`. Errors during a stream arrive as an `error` event with the same body.

| Slug | Status | Means | Fix |
|---|---|---|---|
| `validation-failed` | 400 | A field is invalid. `errors` lists each one | Fix the fields and retry |
| `unauthorized` | 401 | The token is missing, malformed, or rejected by the notes API | Log in to the notes API again |
| `not-found` | 404 | The route, thread, or run doesn't exist, or isn't yours | Check the ID |
| `thread-busy` | 409 | The thread is still answering a message | Wait for `done`, then retry |
| `approval-pending` | 409 | The thread waits for a tool approval | Approve or decline the pending call |
| `approval-not-pending` | 409 | That run isn't waiting for this tool call, or it was already decided | Check `runId` and `toolCallId` |
| `duplicate-request` | 409 | A request with this `Idempotency-Key` already started a run. `runId` names it | Read the reply with `GET /v1/threads/{id}` instead of sending again |
| `payload-too-large` | 413 | The body is over 64 KiB | Send less |
| `unsupported-media-type` | 415 | The body isn't JSON | Send `Content-Type: application/json` |
| `idempotency-key-reused` | 422 | The `Idempotency-Key` was used within 24 hours for a different request | Use a new key for each new message |
| `rate-limited` | 429 | Too many requests this minute | Wait for `Retry-After` |
| `budget-exceeded` | 429 | Today's budget has less than `AGENT_RUN_TOKEN_LIMIT` tokens left for a new run, counting what your streaming runs hold. In an approval's stream, the run ended because the budget couldn't resume it | Wait for `Retry-After`: 00:00 UTC, or 5 seconds when your other runs hold the tokens. After an approval, ask again then |
| `too-many-runs` | 429 | You already have `AGENT_MAX_CONCURRENT_RUNS` runs streaming. In an approval's stream, the run ended for that reason | Wait for one to send `done`, then retry after `Retry-After`. After an approval, ask again then |
| `internal-error` | 500 | A bug. `detail` has a request ID | Quote the request ID |
| `service-unavailable` | 503 | Postgres, the notes API, the model provider, or the prompt injection check failed, the run timed out, the server shut down during the run, or it's draining | Retry later |

`src/platform/problem.ts` is the source of truth for slugs and statuses. `test/unit/problem.test.ts` fails if this table and it differ.
