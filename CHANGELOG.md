# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
