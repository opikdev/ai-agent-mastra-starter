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
| `GUARDRAIL_ON_ERROR` | `block` | When the prompt injection check itself fails: `block` fails the run with `guardrail_unavailable`, `allow` lets the message through. Both log a `guardrail.failed` warning |
| `AGENT_MAX_STEPS` | `8` | Model calls per run |
| `AGENT_MAX_OUTPUT_TOKENS` | `16000` | Output tokens per model call, thinking included. Claude 5.5 models think adaptively, so leave room above the longest answer you expect |
| `AGENT_RUN_TIMEOUT_MS` | `120000` | Longest a run may take |
| `AGENT_RUN_TOKEN_LIMIT` | `100000` | Most tokens one run may spend. Starting a run reserves this much of the budget. At most `DAILY_TOKEN_BUDGET` |
| `AGENT_MAX_CONCURRENT_RUNS` | `3` | Runs one user may have streaming at once |
| `AGENT_MEMORY_MESSAGES` | `20` | Earlier messages the agent sees |
| `DAILY_TOKEN_BUDGET` | `500000` | Input plus output tokens per user per UTC day, from the agent and the guardrail together |
| `RUN_RETENTION_DAYS` | `30` | Days to keep finished runs and daily token usage |
| `THREAD_RETENTION_DAYS` | `90` | Days a thread may go unused before it's deleted with its messages. `0` keeps threads until their user deletes them |
| `APPROVAL_TTL_HOURS` | `24` | Hours an approval may wait before its run fails and the thread unlocks |
| `RATE_LIMIT_PER_MINUTE` | `300` | Requests per client network per minute: an IPv4 address or an IPv6 /64 |
| `AGENT_RATE_LIMIT_PER_MINUTE` | `20` | Messages and approvals per user per minute |
| `CORS_ORIGINS` | None | Comma-separated browser origins. They can read `X-Request-Id`, `Location`, `Retry-After`, `RateLimit`, `RateLimit-Policy`, and `WWW-Authenticate` |
| `TRUST_PROXY_HOPS` | `0` | Proxies in front of the server that append to `X-Forwarded-For`. See [Client IPs](#client-ips) |
| `DOCS_ENABLED` | `false` | Serves `/docs` and `/openapi.json`. Off, both return 404. `.env.example` and Compose turn it on |
| `SHUTDOWN_DRAIN_SECONDS` | `5` | How long `/readyz` returns 503 before the server stops accepting connections. `0` skips the drain |
| `SHUTDOWN_TIMEOUT_SECONDS` | `30` | How long runs in flight get to finish before they're aborted. At least `DATABASE_STATEMENT_TIMEOUT_MS` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | None | OTLP over HTTP collector, such as `http://collector:4318`. Turns on traces and metrics |
| `OTEL_SERVICE_NAME` | `ai-agent-mastra-starter` | Service name on traces and metrics |
| `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` | `false` | Puts messages, replies, and tool data in spans. See [Tracing](#tracing) |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`, or `silent` |
| `PORT`, `DATABASE_STATEMENT_TIMEOUT_MS` | `3000`, `5000` | Server basics |

An empty variable, such as `KEY=` in `.env`, counts as unset, so its default applies.

## Deploy

[Go live](deploy.md) is the checklist: TLS, secrets, migrations, draining, docs, and telemetry. In short:

1. Create the `agent_app` role and grants as in `docker/postgres/init.sql`, with a strong password.
2. Run `node src/db/migrate.ts` with `MIGRATION_DATABASE_URL` as one job before each release. It applies Drizzle migrations and Mastra's own tables, under a Postgres advisory lock, so a second runner waits and then has nothing to do.
3. Run the image with `DATABASE_URL` for `agent_app`. Check `/readyz` before sending traffic.

The image is published to `ghcr.io/<owner>/<repo>` for each `v*` tag, once CI passes on that tag and Trivy finds no fixable HIGH or CRITICAL vulnerability. It carries an SBOM and a build provenance attestation. Any number of instances can run at once: runs, approvals, budgets, reservations, and limits all live in Postgres.

On `SIGTERM` or `SIGINT`, the server fails `/readyz` for `SHUTDOWN_DRAIN_SECONDS`, then stops accepting connections and lets runs in flight finish for up to `SHUTDOWN_TIMEOUT_SECONDS`. It then aborts what's left: each aborted run is saved as `failed` with reason `shutdown`, frees its reserved tokens, and its client gets an `error` event and then `done` with status `aborted`, so the thread is free on the next instance. Set the platform's grace period above drain + timeout + 15 seconds, such as Compose's `stop_grace_period: 50s`.

Streams can last up to `AGENT_RUN_TIMEOUT_MS`, so set your proxy's read timeout above it, and turn off response buffering for `text/event-stream`. A keepalive comment every 10 seconds stops idle timeouts from cutting a stream short.

## Client IPs

The per-IP rate limit needs the client's real address. `TRUST_PROXY_HOPS` says where to find it:

| Value | Client IP |
|---|---|
| `0` | The socket address. `X-Forwarded-For` is ignored, so clients can't spoof it |
| `N` ≥ 1 | The Nth address from the right of `X-Forwarded-For`, with every header's values joined. If there are fewer than N, the leftmost |

Set it to the number of proxies you run, such as `1` behind one load balancer. The limit then counts an IPv4 address whole, an IPv4-mapped IPv6 address as its IPv4 address, and any other IPv6 address by its /64, which one subscriber usually holds. If the chosen entry is empty or isn't an IP address, the socket address is used. `TRUST_PROXY` was replaced: setting it stops startup, and `TRUST_PROXY_HOPS=1` does what `TRUST_PROXY=true` did.

## Costs

Each message costs at least one model call, plus one Haiku call for the guardrail. Defaults at Claude list prices:

| Item | Cost |
|---|---|
| Sonnet 5.5 | $2 per million input tokens, $10 per million output tokens |
| Haiku 5.5 guardrail | $0.10 per million input tokens, $0.50 per million output tokens |
| A worst-case run | `AGENT_RUN_TOKEN_LIMIT`, 100,000 tokens, at most about $1 if it's all Sonnet output |
| A user's full daily budget | 500,000 tokens, at most about $5 if it's all Sonnet output |

The budget counts every model call, the guardrail's included. Tokens count the same whichever model spent them, so a Haiku token uses as much budget as a Sonnet token. Cached input tokens count in full too, though cache reads cost a tenth of the input price and cache writes a quarter more. To price usage, read the `agent` and `guardrail` split and the cache fields in `GET /v1/usage` or a run's `done` event, and apply each model's rates.

Before a run streams, it reserves `AGENT_RUN_TOKEN_LIMIT` tokens of its user's budget, in the same transaction that opens it. A run starts only when the tokens spent today, plus those its user's other runs hold, plus the reservation, fit in `DAILY_TOKEN_BUDGET`, so parallel messages can't overspend it. Each step's tokens move from the reservation to the day's usage as it finishes, and the run frees the rest when it ends. The run stops before a step that could take it past its reservation, ending as `incomplete` with reason `token_limit`. That check projects the next step from the last one and can't project the first, so a step with an unusually large input, such as a long tool result, can still pass the reservation by that much. A process that dies mid-run frees its reservation once the run counts as stale, `AGENT_RUN_TIMEOUT_MS` plus 30 seconds later.

This means a user can't start a run with less than `AGENT_RUN_TOKEN_LIMIT` left today. Keep the budget several times the limit. `AGENT_MAX_CONCURRENT_RUNS` caps how many runs one user streams at once, so one user can't tie up the model's rate limit.

## Prompt caching

Each request to Claude carries two cache breakpoints: one after the tools and instructions, which every user shares, and Anthropic's automatic breakpoint at the end of the prompt, which moves forward as the run goes. Each step of a run, and the next message in a thread, reads the prefix from the cache. Prompts below the model's minimum cacheable length aren't cached, and the fields stay zero.

## Tracing

Set `OTEL_EXPORTER_OTLP_ENDPOINT` to export traces and metrics over OTLP/HTTP. The standard `OTEL_*` variables apply, such as `OTEL_EXPORTER_OTLP_HEADERS` for an API key, and `OTEL_METRIC_EXPORT_INTERVAL`, 60000 ms by default.

- **Traces:** each request gets a span, with its database queries inside. Mastra adds spans for each agent run, model call, and tool call, in the request's trace. Calls to the notes API carry `traceparent`, so its spans join the trace too. Health checks aren't traced.
- **Content:** following the OpenTelemetry GenAI conventions, spans leave out messages, replies, and tool arguments and results unless `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true`. Turn it on only where your trace store may hold user data. The system prompt stays in spans either way. Fields named like secrets, such as `token` or `authorization`, are always redacted.
- **Metrics:** `gen_ai.client.token.usage`, a histogram of tokens per model call by `gen_ai.token.type`, `gen_ai.request.model`, and `agent.model.role`; `agent.run.duration`, a histogram of seconds per run by `agent.run.status` and `agent.run.stop_reason`, whose count is the number of runs; and `http.server.request.duration` and the pool's `db.client.connection.*`. They're flushed on shutdown.

## Logs

Logs are JSON lines on stdout. Each request logs its method, path, status, duration, and request ID, and health checks log at `debug`. Lines written during a traced request carry its `trace_id` and `span_id`. Problem responses repeat the request ID, so users can quote it.

A failed prompt injection check logs a warning with `event: "guardrail.failed"` and `action` set to `block` or `allow`, whichever `GUARDRAIL_ON_ERROR` did.

Logs never hold prompts, replies, tool arguments or results, or tokens:

- Errors are logged as their type, message, stack, cause, and, when present, `code`, `statusCode`, `url`, and `isRetryable`. Model provider errors carry the whole prompt, so nothing else is kept.
- Mastra's own logs stay at `info` or above, even with `LOG_LEVEL=debug`, because its debug logs include model text and tool results.

## Clean up

Every hour, one instance, picked by a Postgres advisory lock, does this:

- Deletes expired rate limit rows and `Idempotency-Key` records.
- Fails runs that have waited for approval longer than `APPROVAL_TTL_HOURS`, so their threads take messages again.
- Fails runs a dead process left running, which frees the tokens they reserved.
- Deletes finished runs and `token_usage` days older than `RUN_RETENTION_DAYS`.
- Deletes threads, and their messages, that nobody used for `THREAD_RETENTION_DAYS`, up to 1,000 an hour, oldest first. A thread that's answering waits for the next pass.

An expired approval leaves its paused run snapshot in `mastra.mastra_workflow_snapshot`, because Mastra has no public API to delete an agent run's snapshot. Delete rows there whose `run_id` no longer has an open run in `runs`, if they pile up.

## Back up

Back up the whole database. Threads and messages live in the `mastra` schema.
