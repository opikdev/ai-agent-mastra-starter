# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- The agent layer no longer imports from the HTTP layer. `ProblemError` and the logger moved to `src/platform/`, `AgentContext` moved to `src/agent/context.ts`, and a test enforces the import directions.
- Tools and the agent validate the request context with `requestContextSchema`, and the routes use Mastra's own thread and message types instead of casts.
- Eval golden replies are keyed by case name, and seeded note IDs come from the case name, so adding or reordering cases no longer shifts them.

### Fixed

- `pnpm typecheck` now checks `evals/`.
- A model provider failure no longer logs the whole prompt. Errors in the app and Mastra logs keep only their type, message, stack, cause, and HTTP facts, and Mastra never logs at `debug`, which includes model text and tool results.
- Evals run with the configured `AGENT_MAX_STEPS`, `AGENT_MAX_OUTPUT_TOKENS`, and `AGENT_MEMORY_MESSAGES`, through the same `runOptions()` as the API, instead of their own hardcoded options.
- Approving a tool call as soon as `approval-required` arrives no longer fails with `409 approval-not-pending`. The run is saved as waiting first, so the event now comes just before `done`.
- A run that times out or loses its client now cancels its notes API calls, so an update can no longer land after the run failed.

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
