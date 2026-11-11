# Operations

## Configuration

Set these in the environment. `src/config.ts` validates them at startup and names any that are wrong.

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | Required | Postgres URL for the app role |
| `MIGRATION_DATABASE_URL` | Required for migrations | Postgres URL for the owner role |
| `DATABASE_POOL_MAX` | `10` | Most Postgres connections each process opens, for the app and Mastra together. At least 1 |
| `NOTES_API_URL` | Required | The API the agent acts on. It checks tokens and serves the tools. Any API that meets the [contract](notes-api.md) works |
| `NOTES_API_TIMEOUT_MS` | `5000` | Timeout for each notes API call |
| `ANTHROPIC_API_KEY` | Required for `anthropic/` models | Never logged or sent to tools |
| `ANTHROPIC_BASE_URL` | Anthropic's API | Send model calls through a proxy or gateway |
| `AGENT_MODEL` | `anthropic/claude-sonnet-5-5` | Any Mastra model ID |
| `GUARDRAIL_MODEL` | `anthropic/claude-haiku-5-5` | The prompt injection checker. `off` turns it off |
| `AGENT_MAX_STEPS` | `8` | Model calls per run |
| `AGENT_MAX_OUTPUT_TOKENS` | `4096` | Output tokens per model call |
| `AGENT_RUN_TIMEOUT_MS` | `120000` | Longest a run may take |
| `AGENT_MEMORY_MESSAGES` | `20` | Earlier messages the agent sees |
| `DAILY_TOKEN_BUDGET` | `500000` | Input plus output tokens per user per UTC day, from the agent and the guardrail together |
| `RUN_RETENTION_DAYS` | `30` | Days to keep finished runs and daily token usage |
| `APPROVAL_TTL_HOURS` | `24` | Hours an approval may wait before its run fails and the thread unlocks |
| `RATE_LIMIT_PER_MINUTE` | `300` | Requests per IP per minute |
| `AGENT_RATE_LIMIT_PER_MINUTE` | `20` | Messages and approvals per user per minute |
| `CORS_ORIGINS` | None | Comma-separated browser origins. They can read `X-Request-Id`, `Location`, `Retry-After`, `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`, and `WWW-Authenticate` |
| `TRUST_PROXY_HOPS` | `0` | Proxies in front of the server that append to `X-Forwarded-For`. See [Client IPs](#client-ips) |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | None | OTLP over HTTP collector, such as `http://collector:4318` |
| `OTEL_SERVICE_NAME` | `ai-agent-mastra-starter` | Service name on traces |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`, or `silent` |
| `PORT`, `DATABASE_STATEMENT_TIMEOUT_MS` | `3000`, `5000` | Server basics |

## Deploy

1. Create the `agent_app` role and grants as in `docker/postgres/init.sql`, with a strong password.
2. Run `node src/db/migrate.ts` with `MIGRATION_DATABASE_URL` before each release. It applies Drizzle migrations and Mastra's own tables.
3. Run the image with `DATABASE_URL` for `agent_app`. Check `/readyz` before sending traffic.

The image is published to `ghcr.io/<owner>/<repo>` for each `v*` tag, once `pnpm verify` and the end-to-end tests pass on that tag. Any number of instances can run at once: runs, approvals, budgets, and limits all live in Postgres.

On `SIGTERM` or `SIGINT`, the server aborts its open runs, waits for their streams to close, and exits within 9 seconds. Each aborted run is saved as failed, and its client gets an `error` event and then `done` with status `aborted`, so the thread is free on the next instance. Give the container a stop grace period of at least 10 seconds, which is Docker's and Kubernetes' default.

Put the service behind TLS. Streams can last up to `AGENT_RUN_TIMEOUT_MS`, so set your proxy's read timeout above it, and turn off response buffering for `text/event-stream`. A keepalive comment every 10 seconds stops idle timeouts from cutting a stream short.

## Client IPs

The per-IP rate limit needs the client's real address. `TRUST_PROXY_HOPS` says where to find it:

| Value | Client IP |
|---|---|
| `0` | The socket address. `X-Forwarded-For` is ignored, so clients can't spoof it |
| `N` ≥ 1 | The Nth address from the right of `X-Forwarded-For`, with every header's values joined. If there are fewer than N, the leftmost |

Set it to the number of proxies you run, such as `1` behind one load balancer. If the chosen entry is empty or isn't an IP address, the socket address is used. `TRUST_PROXY` was replaced: setting it stops startup, and `TRUST_PROXY_HOPS=1` does what `TRUST_PROXY=true` did.

## Costs

Each message costs at least one model call, plus one Haiku call for the guardrail. Defaults at Claude list prices:

| Item | Cost |
|---|---|
| Sonnet 5.5 | $2 per million input tokens, $10 per million output tokens |
| Haiku 5.5 guardrail | $0.10 per million input tokens, $0.50 per million output tokens |
| A worst-case run | 8 steps × 4,096 output tokens, about $0.33 in output, plus input |
| A user's full daily budget | 500,000 tokens, at most about $5 if it's all Sonnet output |

The budget counts every model call, the guardrail's included. Tokens count the same whichever model spent them, so a Haiku token uses as much budget as a Sonnet token. To price them, read the `agent` and `guardrail` split in `GET /v1/usage` or a run's `done` event, and apply each model's rates.

The budget is checked once, before a run starts. The guardrail call is part of the run, so it's made even when the run's tokens then go past the budget, and a blocked message still records what the check spent. A run already under way can finish past the budget. The next one is refused.

## Tracing

Set `OTEL_EXPORTER_OTLP_ENDPOINT` to export spans for each agent run, model call, and tool call. Spans include prompts, replies, and tool results, so treat your trace store as holding user data. Fields named like secrets, such as `token` or `authorization`, are redacted.

## Logs

Logs are JSON lines on stdout. Each request logs its method, path, status, duration, and request ID. Problem responses repeat the request ID, so users can quote it.

Logs never hold prompts, replies, tool arguments or results, or tokens:

- Errors are logged as their type, message, stack, cause, and, when present, `code`, `statusCode`, `url`, and `isRetryable`. Model provider errors carry the whole prompt, so nothing else is kept.
- Mastra's own logs stay at `info` or above, even with `LOG_LEVEL=debug`, because its debug logs include model text and tool results.

## Clean up

Every hour, one instance, picked by a Postgres advisory lock, does this:

- Deletes expired rate limit rows.
- Fails runs that have waited for approval longer than `APPROVAL_TTL_HOURS`, so their threads take messages again.
- Deletes finished runs and `token_usage` days older than `RUN_RETENTION_DAYS`.

Threads and messages stay until their user deletes them. An expired approval leaves its paused run snapshot in `mastra.mastra_workflow_snapshot`, because Mastra has no public API to delete an agent run's snapshot. Delete rows there whose `run_id` no longer has an open run in `runs`, if they pile up.

## Back up

Back up the whole database. Threads and messages live in the `mastra` schema.
