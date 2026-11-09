# 004. Keep budgets and runs in Postgres

- **Status**: accepted
- **Context**: An agent can loop and spend money fast. Mastra's cost control processor relies on observability metrics and price tables, and skips the check when either is missing. Two messages on one thread at once would interleave their memory.
- **Decision**: Count each model call's tokens per user per UTC day in `token_usage`, and refuse new runs over `DAILY_TOKEN_BUDGET`. Track runs in `runs`, with a partial unique index that allows one open run per thread.
- **Consequences**:
  - Budgets and run state hold across instances and restarts, with no Redis.
  - Budgets count tokens, not dollars, so changing models changes what a budget costs.
  - A run in flight can finish over budget. Step, output, and time limits cap how far.
