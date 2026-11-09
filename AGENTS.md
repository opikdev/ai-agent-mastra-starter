# Agent guide

A production-ready AI agent API in TypeScript: Mastra, Claude, Hono, Drizzle, and Postgres, with tools, approvals, memory, guardrails, budgets, and evals. The notes assistant is the sample agent to copy or replace.

| Path | Purpose |
|---|---|
| [docs/architecture.md](docs/architecture.md) | How a message becomes an agent run, and which module does what |
| [docs/api.md](docs/api.md) | Endpoints, stream events, and approvals |
| [docs/customize.md](docs/customize.md) | How to change the model, add a tool, or connect another API |
| [docs/evals.md](docs/evals.md) | How to add and run evals |
| [docs/errors.md](docs/errors.md) | Every problem type the API can return |
| [docs/operations.md](docs/operations.md) | Configuration, deploys, costs, and tracing |
| [docs/decisions/](docs/decisions/) | Why it's built this way |
| `.agents/skills/` | Step-by-step guides for recurring tasks |
| `.mcp.json` | MCP servers for this project |

## Commands

| Task | Command |
|---|---|
| Run everything | `docker compose up --build --wait agent` |
| Run the agent on your machine | `docker compose up --build --wait db notes-api`, `docker compose run --build --rm migrate`, then `pnpm dev` |
| Run all gates | `pnpm verify` |
| Test against the real Docker images | `pnpm test:e2e` |
| Run the live evals | `pnpm eval` |
| Create a migration | `pnpm db:generate` |

## Rules

- Don't commit until `pnpm verify` passes. Tests need Docker, or `TEST_DATABASE_URL` set to a Postgres 18 server. If neither is available, stop and report that instead of committing.
- Run `pnpm verify` before calling work done. For changes to Docker, Compose, or startup, run `pnpm test:e2e` too.
- If the check blocks you, fix the cause. Never edit `.agents/check.sh`, `.githooks/`, or the harness workflow to get past it, and never use `--no-verify`. If the request can't be done without that, stop and ask.
- After cloning, run `git config core.hooksPath .githooks` once to turn on the hook.
- Tests never call a real model. Script replies on the fake in `test/fake-anthropic.ts`. Only `pnpm eval` spends money, so ask before running it.
- Never send `temperature`, `top_p`, `top_k`, a forced `tool_choice`, or an assistant prefill. Claude 5.5 models reject them.
- Give every tool that changes or deletes data `requireApproval: true`, and add an eval case for it.
- Tools call outside systems with the caller's own credentials from the request context. Never give a tool a shared admin credential.
- Tools return `{ error }` for failures the model can act on, and throw for bugs.
- Throw `ProblemError` for every HTTP failure, and add new types to `src/platform/problem.ts` and `docs/errors.md`.
- Keep imports pointing one way: `http` to `agent` to `notes`, `db`, and `platform`. Only `src/http/` uses Hono. `test/unit/architecture.test.ts` enforces it.
- Never log prompts, messages, tool arguments or results, or tokens. Log errors as `err`, which `src/platform/logger.ts` reduces to what failed.
- Scope every thread and run to the caller's user ID. Return 404, not 403, for someone else's.
- Change the database by editing `src/db/schema.ts`, then running `pnpm db:generate`. Migrations are append-only, so never edit one that's committed.
- Don't edit files listed in `.baseline.sha256`. They come from [opikdev/starters](https://github.com/opikdev/starters).
- Keep this file a short map, and put detail in `docs/`.
- Fix any doc your change makes wrong, in the same change.
- Record significant decisions with the `record-decision` skill.
- Back important rules with a lint rule, hook, or CI check.
