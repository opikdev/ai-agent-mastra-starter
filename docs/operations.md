# Operations

## Configuration

Set these in the environment. `src/config.ts` validates them at startup and names any that are wrong.

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | Required | Postgres URL for the app role |
| `MIGRATION_DATABASE_URL` | Required for migrations | Postgres URL for the owner role |
| `NOTES_API_URL` | Required | The API the agent acts on. It checks tokens and serves the tools |
| `NOTES_API_TIMEOUT_MS` | `5000` | Timeout for each notes API call |
| `ANTHROPIC_API_KEY` | Required for `anthropic/` models | Never logged or sent to tools |
| `ANTHROPIC_BASE_URL` | Anthropic's API | Send model calls through a proxy or gateway |
| `AGENT_MODEL` | `anthropic/claude-sonnet-5-5` | Any Mastra model ID |
| `GUARDRAIL_MODEL` | `anthropic/claude-haiku-5-5` | The prompt injection checker. `off` turns it off |
| `AGENT_MAX_STEPS` | `8` | Model calls per run |
| `AGENT_MAX_OUTPUT_TOKENS` | `4096` | Output tokens per model call |
| `AGENT_RUN_TIMEOUT_MS` | `120000` | Longest a run may take |
| `AGENT_MEMORY_MESSAGES` | `20` | Earlier messages the agent sees |
| `DAILY_TOKEN_BUDGET` | `500000` | Input plus output tokens per user per UTC day |
| `RATE_LIMIT_PER_MINUTE` | `300` | Requests per IP per minute |
| `AGENT_RATE_LIMIT_PER_MINUTE` | `20` | Messages and approvals per user per minute |
| `CORS_ORIGINS` | None | Comma-separated browser origins |
| `TRUST_PROXY` | `false` | Read the client IP from `X-Forwarded-For`. Only behind a proxy that sets it |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | None | OTLP over HTTP collector, such as `http://collector:4318` |
| `OTEL_SERVICE_NAME` | `ai-agent-mastra-starter` | Service name on traces |
| `PORT`, `LOG_LEVEL`, `DATABASE_STATEMENT_TIMEOUT_MS` | `3000`, `info`, `5000` | Server basics |

## Deploy

1. Create the `agent_app` role and grants as in `docker/postgres/init.sql`, with a strong password.
2. Run `node src/db/migrate.ts` with `MIGRATION_DATABASE_URL` before each release. It applies Drizzle migrations and Mastra's own tables.
3. Run the image with `DATABASE_URL` for `agent_app`. Check `/readyz` before sending traffic.

The image is published to `ghcr.io/<owner>/<repo>` for each `v*` tag. Any number of instances can run at once: runs, approvals, budgets, and limits all live in Postgres.

On `SIGTERM` or `SIGINT`, the server aborts its open runs, waits for their streams to close, and exits within 9 seconds. Each aborted run is saved as failed, and its client gets an `error` event and then `done` with status `aborted`, so the thread is free on the next instance. Give the container a stop grace period of at least 10 seconds, which is Docker's and Kubernetes' default.

Put the service behind TLS. Streams can last up to `AGENT_RUN_TIMEOUT_MS`, so set your proxy's read timeout above it, and turn off response buffering for `text/event-stream`. A keepalive comment every 10 seconds stops idle timeouts from cutting a stream short.

## Costs

Each message costs at least one model call, plus one Haiku call for the guardrail. Defaults at Claude list prices:

| Item | Cost |
|---|---|
| Sonnet 5.5 | $2 per million input tokens, $10 per million output tokens |
| Haiku 5.5 guardrail | $0.10 per million input tokens, $0.50 per million output tokens |
| A worst-case run | 8 steps × 4,096 output tokens, about $0.33 in output, plus input |
| A user's full daily budget | 500,000 tokens, about $1 to $5 depending on the mix |

The budget counts the agent's calls only. The guardrail's calls aren't counted, because Mastra doesn't report them.

A run already under way can finish past the budget. The next one is refused.

## Tracing

Set `OTEL_EXPORTER_OTLP_ENDPOINT` to export spans for each agent run, model call, and tool call. Spans include prompts, replies, and tool results, so treat your trace store as holding user data. Fields named like secrets, such as `token` or `authorization`, are redacted.

## Logs

Logs are JSON lines on stdout. Each request logs its method, path, status, duration, and request ID. Problem responses repeat the request ID, so users can quote it.

Logs never hold prompts, replies, tool arguments or results, or tokens:

- Errors are logged as their type, message, stack, cause, and, when present, `code`, `statusCode`, `url`, and `isRetryable`. Model provider errors carry the whole prompt, so nothing else is kept.
- Mastra's own logs stay at `info` or above, even with `LOG_LEVEL=debug`, because its debug logs include model text and tool results.

## Clean up

The server deletes expired rate limit rows every hour. `runs` and `token_usage` grow by one row per run and one per user per day. Delete old rows on a schedule if you don't need them.

## Back up

Back up the whole database. Threads and messages live in the `mastra` schema.
