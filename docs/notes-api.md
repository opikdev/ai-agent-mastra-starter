# Notes API contract

The agent acts on one HTTP API, set by `NOTES_API_URL`. It checks callers' tokens with that API, and its tools read and change notes there. Any API that meets this contract works, your own included. `src/notes/client.ts` is the only code that calls it, and `test/fake-notes-api.ts` is the fake the tests use.

[api-hono-starter](https://github.com/opikdev/api-hono-starter), [api-go-starter](https://github.com/opikdev/api-go-starter), and [api-fastapi-starter](https://github.com/opikdev/api-fastapi-starter) all implement it. Compose and the end-to-end tests run api-hono-starter's image as an example only. To use another API, see [Use another API](#use-another-api).

## Auth

The agent has no login and no credential of its own. Callers get a token from the API, send it to the agent as `Authorization: Bearer <token>`, and the agent forwards it unchanged.

1. The agent rejects a missing header, another scheme, or a token over 512 characters with 401, without calling the API.
2. It calls `GET /v1/users/me` with the token. A 200 response's `id` becomes the caller's user ID, which scopes their threads, runs, and budget.
3. It caches that answer for 30 seconds, keyed by the token's SHA-256 hash, so a revoked token keeps working for up to 30 seconds.
4. Every tool call in the request uses the same token. The API decides what the caller may read or change.

| `GET /v1/users/me` result | The agent returns |
|---|---|
| 200 with a string `id` | Runs the request as that user |
| 401 | 401 `unauthorized` |
| Any other status, a body without `id`, a timeout, or no connection | 503 `service-unavailable`, with `Retry-After: 5` |

## Requests

Every request sends `Accept: application/json` and `Authorization: Bearer <token>`. Paths are relative to `NOTES_API_URL`, which may include a base path, such as `https://example.com/api`. The agent reads only the fields listed, and ignores the rest.

| Call | Sends | Expects |
|---|---|---|
| `GET /v1/users/me` | Nothing | 200, `{ "id": string }` |
| `GET /v1/notes?limit&cursor` | `limit` 1 to 50, and `cursor` from the previous page's `nextCursor` | 200, `{ "data": Note[], "meta": { "nextCursor": string \| null } }`, newest first |
| `GET /v1/notes/{id}` | The URL-encoded note ID | 200, a Note, with an `ETag` header |
| `POST /v1/notes` | JSON `{ "title": string, "body": string }` | 2xx, the new Note |
| `PATCH /v1/notes/{id}` | `If-Match` with the `ETag` from a `GET` just before it, and JSON with `title`, `body`, or both | 2xx, the updated Note, or 412 if the note changed |
| `DELETE /v1/notes/{id}` | Nothing | 2xx. The body is ignored |

A Note is `{ "id", "title", "body", "createdAt", "updatedAt" }`, all strings. The API must scope notes to the token's user, and return 404 for another user's note. The agent doesn't send an `Idempotency-Key`.

## Errors

Error bodies should be [Problem Details](https://www.rfc-editor.org/rfc/rfc9457). The agent reads only `detail`, and works without it. Tools hand each failure to the model as `{ error }`, so it can explain or retry, and the run goes on.

| Status | What the model sees |
|---|---|
| 401 | The API rejected the credentials |
| 404 | `detail`, or that the note doesn't exist |
| 412 | The note changed, so fetch it again |
| 429 | Retry after the `Retry-After` seconds, or 60 without it |
| Other 4xx | The API refused the request, with `detail` |
| 5xx | The API failed, so try again later |
| A response that doesn't match the schema, or a `GET` without `ETag` before an update | The API sent a response the agent doesn't understand |

## Timeouts

Each call stops after `NOTES_API_TIMEOUT_MS`, 5 seconds by default. An update makes two calls, each with its own timeout. A tool call also stops when its run ends, from a run timeout, a client that disconnects, or a shutdown, so a change can't land after the run failed.

## Use another API

1. Set `NOTES_API_URL` to your API. In `compose.yaml`, change it on the `agent` service, such as to `http://host.docker.internal:8080`, delete the `notes-*` services, and remove `notes-api` from the agent's `depends_on`. Do the same in `.devcontainer/`.
2. Get a token the way your API issues them, and send it to the agent.

If your API's endpoints differ, change `src/notes/client.ts` and the tools, as [Connect your own API](customize.md#connect-your-own-api) shows.
