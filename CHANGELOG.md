# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- The README explains how to start a project with `pik new` or GitHub's **Use this template**. `pik new` removes that section from the project it creates.
- [docs/notes-api.md](docs/notes-api.md) documents the contract the agent needs from the notes API: endpoints, fields, auth, errors, and timeouts.
- Each run reserves `AGENT_RUN_TOKEN_LIMIT` tokens, 100,000 by default, of its user's daily budget before it streams, and stops before a step that could pass it. See [decision 008](docs/decisions/008-reserve-run-tokens-before-streaming.md).
- `AGENT_MAX_CONCURRENT_RUNS`, 3 by default, caps the runs one user streams at once. More return `429 too-many-runs` with `Retry-After`.
- `Idempotency-Key` on `POST /v1/threads/{id}/messages`: a retry within 24 hours returns `409 duplicate-request` with the `runId` the first request started, and the key with a different request returns `422 idempotency-key-reused`.
- Prompt caching: a cache breakpoint after the tools and instructions, and Anthropic's automatic breakpoint at the end of each request. Usage adds `cacheReadInputTokens` and `cacheWriteInputTokens`, and `GET /v1/usage` adds `reserved`.
- `GUARDRAIL_ON_ERROR`, `block` by default. See Changed.
- An OpenAPI 3.1 document generated from the routes, committed as `openapi.json`, with shared problem responses and documented headers. `/openapi.json` and a self-hosted, pinned Swagger UI at `/docs` are served when `DOCS_ENABLED=true`, under a strict CSP. `pnpm openapi:generate` regenerates the file.
- OpenTelemetry metrics over OTLP, alongside traces: `gen_ai.client.token.usage`, `agent.run.duration`, HTTP server metrics, and the pool's. Requests get spans, and Mastra's run spans join the request's trace.
- Log lines written during a traced request carry `trace_id` and `span_id`, and calls to the notes API send `traceparent`.
- `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT`, `false` by default, decides whether spans hold messages, replies, and tool data.
- `THREAD_RETENTION_DAYS`, 90 by default: the hourly cleanup deletes threads nobody used for that long, with their messages. `0` keeps them.
- `SHUTDOWN_DRAIN_SECONDS`, 5 by default, and `SHUTDOWN_TIMEOUT_SECONDS`, 30 by default. See Changed.
- [docs/deploy.md](docs/deploy.md), a go-live checklist: TLS, Postgres TLS, pool sizing, migrations, secrets, draining, docs, the guardrail, and telemetry.
- The release scans the image with Trivy before pushing it, and publishes it with an SBOM, `mode=max` provenance, and a build provenance attestation. CI scans the image on every pull request.

### Changed

- **Breaking:** a reply cut off at the output cap ends as `incomplete` with reason `max_tokens`, or `context_window`, a refusal as `refused`, and a run that uses up its steps or tokens as `incomplete` with `max_steps` or `token_limit`, instead of `completed`. The `done` event adds `reason`, and the run row saves the status and a `stop_reason`. See [decision 010](docs/decisions/010-report-why-a-run-stopped.md).
- **Breaking:** the prompt injection check fails closed. When its model call fails, the run ends as `failed` with reason `guardrail_unavailable` and a `503` problem, instead of letting the message through. `GUARDRAIL_ON_ERROR=allow` restores the old behavior, and both log a `guardrail.failed` warning. See [decision 009](docs/decisions/009-fail-closed-when-the-guardrail-fails.md).
- **Breaking:** the `RateLimit-Limit`, `RateLimit-Remaining`, and `RateLimit-Reset` headers are replaced by `RateLimit` and `RateLimit-Policy` from draft-ietf-httpapi-ratelimit-headers. On a 429, `RateLimit` and `Retry-After` describe the policy that was exceeded.
- **Breaking:** `DOCS_ENABLED` defaults to `false`, so `/docs` and `/openapi.json` return 404 unless it's on. `.env.example` and Compose turn it on. See [decision 011](docs/decisions/011-turn-api-docs-off-by-default.md).
- **Breaking:** `budget-exceeded` now means less than `AGENT_RUN_TOKEN_LIMIT` tokens are left, counting what the user's streaming runs hold. When their runs hold the tokens, `Retry-After` is 5 seconds instead of the time to midnight. Approving a tool call reserves tokens too.
- `AGENT_MAX_OUTPUT_TOKENS` defaults to 16,000, up from 4,096, so adaptive thinking fits.
- The per-IP rate limit counts an IPv4 address whole, an IPv4-mapped IPv6 address as its IPv4 address, and other IPv6 addresses by their /64.
- On `SIGTERM`, the server fails `/readyz` for `SHUTDOWN_DRAIN_SECONDS`, lets runs finish for up to `SHUTDOWN_TIMEOUT_SECONDS`, then aborts the rest with reason `shutdown` and frees their tokens. It used to abort every run at once. Compose's `stop_grace_period` is 50 seconds.
- Migrations take a Postgres advisory lock, so concurrent runners apply them once, and DDL gives up after a 5-second `lock_timeout`.
- Compose builds the image once and runs `migrate` and `agent` from it, on a read-only filesystem.
- The image's base is pinned by digest, without npm or npx, and its health check uses `wget`. Renovate pins Docker digests and waits 3 days before taking a new release.
- The SBOM workflow job reads the repo with `contents: read`.
- Health checks log at `debug` and aren't traced.
- Usage in the `done` event and `GET /v1/usage` adds `agent` and `guardrail` objects, each with `inputTokens` and `outputTokens`. The top-level totals now include the guardrail's tokens.
- Any API that meets the notes API contract works. Compose and the end-to-end tests run api-hono-starter as an optional example backend, now at 0.4.0.
- Compose and the end-to-end tests run the hardened api-hono-starter 0.5.0 on a read-only filesystem. The notes client already relied only on `Retry-After` and the problem `detail`, so its rate-limit headers and error changes need nothing else.

### Security

- Every `/v1` response is `Cache-Control: no-store`, and every response but `/docs` has `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`.
- The `Bearer` scheme matches case-insensitively, with any number of spaces before the token.
- A failed guardrail call no longer reaches the console with the user's message in its error.

### Fixed

- The quick start no longer crashes at startup: an empty variable, such as Compose's `OTEL_EXPORTER_OTLP_ENDPOINT=""` or `KEY=` in `.env`, counts as unset. Compose leaves unset host variables unset, and a test boots the app with `.env.example`.
- Parallel messages can no longer spend past the daily budget. Before, each checked the budget, then all of them ran.
- The `approval-pending` problem names the run by its public `run_...` ID, not its internal UUID.
- The prompt injection guardrail's tokens count toward the daily budget and the run's usage. Before, only the agent's calls counted. A message the guardrail blocks still records the check's tokens. The migration adds two `token_usage` columns with defaults, so it doesn't rewrite the table.
- A run's token usage, in its `done` event and in the daily budget, no longer sometimes counts the run's total again for its last model call. That happened when the client read the stream more slowly than the model answered.

## [0.2.0] - 2026-11-09

### Added

- Streams send a `: keepalive` comment every 10 seconds, so proxies don't drop them while the model is slow.
- `RUN_RETENTION_DAYS`, 30 by default: the hourly cleanup deletes finished runs and token usage older than that, on one instance at a time.
- `APPROVAL_TTL_HOURS`, 24 by default: an approval nobody answers fails after that, so its thread takes messages again.
- `DATABASE_POOL_MAX`, 10 by default, sets the Postgres pool size each process shares with Mastra.

### Changed

- The agent layer no longer imports from the HTTP layer. `ProblemError` and the logger moved to `src/platform/`, `AgentContext` moved to `src/agent/context.ts`, and a test enforces the import directions.
- Tools and the agent validate the request context with `requestContextSchema`, and the routes use Mastra's own thread and message types instead of casts.
- Eval golden replies are keyed by case name, and seeded note IDs come from the case name, so adding or reordering cases no longer shifts them.
- Migration `0001` drops the unused `idx_runs_user_id` index.
- **Breaking:** `TRUST_PROXY` is replaced by `TRUST_PROXY_HOPS`, the number of proxies that append to `X-Forwarded-For`, 0 by default. The server refuses to start while `TRUST_PROXY` is set. Set `TRUST_PROXY_HOPS=1` for what `TRUST_PROXY=true` did.
- Removed the unused `method-not-allowed` problem type. A test keeps `docs/errors.md` and the problem types in step.
- `pnpm db:check`, and so `pnpm verify`, now fails locally on an edited migration, comparing with the merge base of `origin/main`, or `main`. Without either, it skips that check and says so.
- The release workflow publishes the image only after `pnpm verify` and the end-to-end tests pass on the tag.
- The agent harness is v0.3.0. Its check also fails when the harness workflow or pre-commit hook is missing or no longer runs the check.
- `renovate.json` belongs to the project and extends the shared baseline preset. Generated projects extend only `config:recommended`.

### Fixed

- `pnpm typecheck` now checks `evals/`.
- A model provider failure no longer logs the whole prompt. Errors in the app and Mastra logs keep only their type, message, stack, cause, and HTTP facts, and Mastra never logs at `debug`, which includes model text and tool results.
- Evals run with the configured `AGENT_MAX_STEPS`, `AGENT_MAX_OUTPUT_TOKENS`, and `AGENT_MEMORY_MESSAGES`, through the same `runOptions()` as the API, instead of their own hardcoded options.
- Approving a tool call as soon as `approval-required` arrives no longer fails with `409 approval-not-pending`. The run is saved as waiting first, so the event now comes just before `done`.
- A run that times out or loses its client now cancels its notes API calls, so an update can no longer land after the run failed.
- Shutting down no longer leaves runs marked running, which made their threads return `409 thread-busy` for minutes after each deploy. `SIGTERM` aborts open runs, which end as failed with an `error` event and `done` status `aborted`, and the process exits within 9 seconds.
- Browsers on a `CORS_ORIGINS` origin can now read the `X-Request-Id`, `Location`, `Retry-After`, `RateLimit-*`, and `WWW-Authenticate` headers.

## [0.1.0] - 2026-11-09

### Added

- Notes assistant agent on Mastra, with Claude Sonnet 5.5 by default.
- Streaming HTTP API for threads, messages, approvals, and usage.
- Tools that act as the caller against the notes API, with approval for updates and deletes.
- Postgres memory, approval snapshots that survive restarts, and one open run per thread.
- Prompt injection guardrail on Claude Haiku 5.5, daily token budgets, rate limits, and run timeouts.
- Deterministic eval tests and live evals.
- Docker image, Compose stack with the notes API, OpenTelemetry traces, and end-to-end tests.

[Unreleased]: https://github.com/opikdev/ai-agent-mastra-starter/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/opikdev/ai-agent-mastra-starter/releases/tag/v0.1.0
