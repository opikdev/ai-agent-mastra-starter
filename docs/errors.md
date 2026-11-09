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
| `payload-too-large` | 413 | The body is over 64 KiB | Send less |
| `unsupported-media-type` | 415 | The body isn't JSON | Send `Content-Type: application/json` |
| `rate-limited` | 429 | Too many requests this minute | Wait for `Retry-After` |
| `budget-exceeded` | 429 | Today's token budget is spent | Wait for `Retry-After`, at 00:00 UTC |
| `internal-error` | 500 | A bug. `detail` has a request ID | Quote the request ID |
| `service-unavailable` | 503 | Postgres, the notes API, or the model provider failed, the run timed out, or the server shut down during the run | Retry later |

`src/platform/problem.ts` is the source of truth for slugs and statuses.
