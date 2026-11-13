# Go live

A checklist for running the agent in production. [Operations](operations.md) lists every setting.

## Put it behind TLS

- Terminate TLS at a load balancer or reverse proxy, and forward plain HTTP to the agent's `PORT`.
- Set `TRUST_PROXY_HOPS` to the number of proxies that append to `X-Forwarded-For`, usually `1`. Left at `0`, every client shares the proxy's rate limit. Set too high, clients can pick their own address.
- The agent sends `Strict-Transport-Security` on every response. Serve it only over HTTPS, because browsers then refuse plain HTTP to that host for 180 days.
- Set the proxy's read timeout above `AGENT_RUN_TIMEOUT_MS`, and turn off response buffering for `text/event-stream`.

## Connect to Postgres over TLS

Verify the server's certificate, not just encryption:

```sh
DATABASE_URL='postgres://agent_app:<PASSWORD>@db.example.com:5432/agent?sslmode=verify-full&sslrootcert=/etc/ssl/certs/db-ca.pem'
```

Mount your provider's CA bundle at the `sslrootcert` path. Use the same options in `MIGRATION_DATABASE_URL`.

## Size the pool

Keep `DATABASE_POOL_MAX` × replicas, plus the migration job's two connections, below Postgres's `max_connections`, with room for admin sessions. With 10 replicas, a pool of 10, and `max_connections` of 200, you use 102. Mastra shares the pool, so a streaming run holds connections only while it reads or writes.

To run more replicas than that, put PgBouncer in front in transaction mode, with two caveats:

- The agent sets `statement_timeout` as a startup parameter, so add it to PgBouncer's `ignore_startup_parameters` and set the timeout on the role instead: `ALTER ROLE agent_app SET statement_timeout = '5s'`.
- Point `MIGRATION_DATABASE_URL` straight at Postgres, because the migration lock is a session-level advisory lock.

## Run migrations once per deploy

Run the migrations as one job before the new version takes traffic:

1. Run `node src/db/migrate.ts` from the new image, with `MIGRATION_DATABASE_URL` set to the owner role.
2. Roll out the new image with `DATABASE_URL` set to `agent_app`.
3. Send traffic once `GET /readyz` returns 200.

The runner holds a Postgres advisory lock for the whole run, so running it in every replica is also safe: the others wait, then find nothing to apply. Each statement gives up after 5 seconds waiting for a table lock, instead of stalling traffic behind it, so retry the job if a long query was in the way.

Drizzle applies all pending migrations in one transaction, so every lock a statement takes is held until the last one commits. On small tables that's a moment. On a large table, a new `CHECK` or foreign key scans every row, and `CREATE INDEX` blocks writes, for that whole time. For those, split the change across releases instead:

- Add the constraint with `NOT VALID` in one release, and `VALIDATE CONSTRAINT` in a migration of the next one.
- Run `CREATE INDEX CONCURRENTLY` by hand before the deploy, since it can't run inside a transaction, and write the migration's index as `CREATE INDEX IF NOT EXISTS`.

## Keep secrets out of images

- Read `DATABASE_URL`, `MIGRATION_DATABASE_URL`, and `ANTHROPIC_API_KEY` from your platform's secret store, such as Kubernetes Secrets or AWS Secrets Manager. Never bake them into an image or commit them.
- `docker/postgres/init.sql` creates `agent_app` with a dev password. Run it once as the owner role, then set the real password without editing the file. psql reads it from the environment, so it stays out of files, shell history, and the process list:

  ```sh
  psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
  \getenv password AGENT_APP_PASSWORD
  ALTER ROLE agent_app PASSWORD :'password';
  SQL
  ```

- Set the owner role's password in your provider's console, or the same way. Rotate either by changing the role, then the secret, then restarting.

## Drain before shutdown

On `SIGTERM`, the agent fails `/readyz` and keeps serving for `SHUTDOWN_DRAIN_SECONDS`, so the load balancer stops sending new requests. It then stops accepting connections and lets runs in flight finish for up to `SHUTDOWN_TIMEOUT_SECONDS`. Runs still going then are aborted: each is saved as `failed` with reason `shutdown`, frees its reserved tokens, and tells its client, which can send the message again to another instance. Last, it closes Mastra and the pool and flushes telemetry. It exits with code 1 if all of that takes 15 seconds longer than the drain plus the timeout.

| Setting | Set it to |
|---|---|
| `SHUTDOWN_DRAIN_SECONDS` | At least the load balancer's health-check interval × its unhealthy threshold. Default `5` |
| `SHUTDOWN_TIMEOUT_SECONDS` | How long a run may keep going during a deploy. Runs take up to `AGENT_RUN_TIMEOUT_MS`, so raise it toward that to abort fewer. Default `30` |
| Kubernetes `terminationGracePeriodSeconds`, ECS `stopTimeout`, or Compose `stop_grace_period` | Over drain + timeout + 15, such as `50` |
| Load balancer deregistration delay, such as the AWS target group's | At least drain + timeout, such as `35` |

Use `/readyz` for readiness and `/healthz` for liveness. `/healthz` stays 200 during a database outage and while draining, so restarts don't make an outage worse.

## Leave the docs off

`DOCS_ENABLED` defaults to `false`, so `/docs` and `/openapi.json` return 404. Turn it on only if you mean to publish the API's contract. The docs page loads nothing from other origins.

## Keep the guardrail closed

`GUARDRAIL_ON_ERROR` defaults to `block`: if the prompt injection check can't run, the message fails with `503` in the stream instead of reaching the agent. Alert on the `guardrail.failed` log event. Set `allow` only if availability matters more to you than the check, as [decision 009](decisions/009-fail-closed-when-the-guardrail-fails.md) explains.

## Send telemetry

Set `OTEL_EXPORTER_OTLP_ENDPOINT` to your collector to export traces and metrics over OTLP/HTTP. Leave `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` off unless your trace store may hold user messages. [Tracing](operations.md#tracing) lists the spans and metrics.

## Back up the database

Turn on your provider's point-in-time recovery. Threads and messages live in the `mastra` schema, so back up the whole database.
