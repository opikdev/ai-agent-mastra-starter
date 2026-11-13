# AI agent Mastra starter

A production-ready AI agent API in TypeScript that you can run with one command and customize with coding agents. It uses Mastra and Claude, and it's already wired with tools, approvals, memory, guardrails, budgets, evals, and tracing.

[![CI](https://github.com/opikdev/ai-agent-mastra-starter/actions/workflows/ci.yml/badge.svg)](https://github.com/opikdev/ai-agent-mastra-starter/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

The sample agent is a notes assistant. It reads and edits a user's notes through any REST API that meets the [notes API contract](docs/notes-api.md), acting as that user. Swap in your own API and tools to build a support agent, an ops copilot, or an assistant inside your product.

## Features

- **Claude by default:** Sonnet 5.5 runs the agent and Haiku 5.5 checks input. Any [Mastra model](https://mastra.ai/models) works through one variable.
- **Acts as the user:** callers send your app's own token, and every tool call uses it. The agent can never do more than the user can.
- **Human approval:** updates and deletes pause until the user approves. Approvals survive restarts.
- **Streaming API:** server-sent events for text, tool calls, approvals, usage, and why a run stopped, with Problem Details errors, an OpenAPI 3.1 document, and `Idempotency-Key` retries.
- **Memory:** threads and messages in Postgres, scoped to each user.
- **Guardrails:** a prompt injection check that fails closed, control character stripping, and size limits.
- **Cost control:** per-user daily token budgets that reserve each run's tokens up front, prompt caching, concurrency and rate limits, and step, output, token, and time limits per run.
- **Evals:** deterministic eval tests in CI, plus live evals against the real model with one command.
- **Ready to operate:** a non-root, digest-pinned Docker image with an SBOM and provenance, graceful draining, health checks, JSON logs, and OpenTelemetry traces and metrics.
- **Agent-ready:** `AGENTS.md`, skills, and checks that run on every commit.
- **Strict gates:** strict types, lint, 90% coverage, and end-to-end tests against the real Docker stack.

## Quick start

You need Docker and an [Anthropic API key](https://platform.claude.com):

```sh
git clone https://github.com/opikdev/ai-agent-mastra-starter
cd ai-agent-mastra-starter
export ANTHROPIC_API_KEY=<YOUR_KEY>
docker compose up --build --wait agent
```

This starts the agent at <http://localhost:3000>, and an example notes API at <http://localhost:3100> with fake seed data. The example is [api-hono-starter](https://github.com/opikdev/api-hono-starter)'s image, and any API that meets the [contract](docs/notes-api.md) can replace it. Log in to the example API to get a token:

```sh
TOKEN=$(curl -s -X POST localhost:3100/v1/sessions -H 'Content-Type: application/json' \
  -d '{"email":"demo@example.com","password":"demo-password-123"}' | jq -r .token)
```

Start a thread, then talk to the agent:

```sh
THREAD=$(curl -s -X POST localhost:3000/v1/threads -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{}' | jq -r .id)
curl -N -X POST localhost:3000/v1/threads/$THREAD/messages -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"content":"What notes do I have?"}'
```

Ask it to delete a note, and the stream sends an `approval-required` event, then ends with `done` and status `awaiting_approval`. [docs/api.md](docs/api.md) shows how to approve it. The API docs are at <http://localhost:3000/docs>.

If a port is taken, set `PORT`, `NOTES_API_PORT`, or `POSTGRES_PORT` before running Compose.

## Start your own project

Create a renamed copy with [pik](https://github.com/opikdev/pik). It downloads this starter's latest release, then sets your project name and GitHub owner:

```sh
pik new ai-agent-mastra-starter my-agent
```

Or select **Use this template** on GitHub. That copy keeps the name `ai-agent-mastra-starter` and the owner `opikdev`, so follow `pik.yaml` by hand: swap the `replace` text, delete the `exclude` paths, and run the `setup` commands.

## Usage

To work on the code, you need Node 26 or later and pnpm:

```sh
pnpm install
cp .env.example .env
docker compose up --build --wait db notes-api
docker compose run --build --rm migrate
pnpm dev
```

| Task | Command |
|---|---|
| Run lint, types, migrations check, tests, and repo checks | `pnpm verify` |
| Run the end-to-end tests against the Docker stack | `pnpm test:e2e` |
| Run the live evals against Claude | `pnpm eval` |
| Create a migration | `pnpm db:generate` |
| Regenerate `openapi.json` after an endpoint changes | `pnpm openapi:generate` |

Tests never call a real model. They use a fake Anthropic API, so they're free and deterministic.

## Documentation

- [API](docs/api.md): endpoints, stream events, and approvals
- [Architecture](docs/architecture.md): how a message becomes an agent run
- [Customize](docs/customize.md): change the model, add tools, and connect your own API
- [Notes API contract](docs/notes-api.md): what the agent needs from the API it acts on
- [Evals](docs/evals.md): test the agent's behavior
- [Errors](docs/errors.md): every problem type the API returns
- [Operations](docs/operations.md): configuration, deploys, costs, and tracing
- [Go live](docs/deploy.md): the production checklist: TLS, secrets, migrations, draining, and docs

## Project structure

| Path | Purpose |
|---|---|
| `src/agent/` | The agent, its tools, runs, budgets, and Mastra wiring |
| `src/http/` | Routes, auth, rate limits, idempotency, and the OpenAPI document |
| `src/platform/` | Problem Details errors, the logger, metrics, shutdown, and cleanup |
| `src/notes/` | The client for the API the agent acts on |
| `src/db/` | Schema, connections, and the migration runner |
| `migrations/` | Generated SQL migrations, which are append-only |
| `openapi.json` | The API's OpenAPI 3.1 document, generated from the routes |
| `evals/` | Eval cases and the runner |
| `test/` | Unit, integration, and end-to-end tests, plus fakes for the model and the notes API, so tests need no other service |
| `docs/` | [API](docs/api.md), [architecture](docs/architecture.md), guides, and [decisions](docs/decisions/) |

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request, and follow the [code of conduct](CODE_OF_CONDUCT.md).

## Security

Report vulnerabilities as described in [SECURITY.md](SECURITY.md). The agent acts with each caller's own token, and approvals guard every change, as [decision 002](docs/decisions/002-act-as-the-caller.md) explains.

## License

Released under the [MIT License](LICENSE).
