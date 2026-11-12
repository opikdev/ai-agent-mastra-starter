# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- The README explains how to start a project with `pik new` or GitHub's **Use this template**. `pik new` removes that section from the project it creates.
- [docs/notes-api.md](docs/notes-api.md) documents the contract the agent needs from the notes API: endpoints, fields, auth, errors, and timeouts.

### Changed

- Usage in the `done` event and `GET /v1/usage` adds `agent` and `guardrail` objects, each with `inputTokens` and `outputTokens`. The top-level totals now include the guardrail's tokens.
- Any API that meets the notes API contract works. Compose and the end-to-end tests run api-hono-starter as an optional example backend, now at 0.4.0.
- Compose and the end-to-end tests run the hardened api-hono-starter 0.5.0 on a read-only filesystem. The notes client already relied only on `Retry-After` and the problem `detail`, so its rate-limit headers and error changes need nothing else.

### Fixed

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
