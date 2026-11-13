# 008. Reserve a run's tokens before it streams

- **Status**: accepted
- **Context**: The budget was checked before a run and spending recorded after, so parallel messages all passed the check: 10 at once spent 2,280 tokens against a 1,200 budget. A run's input can't be known before each model call, so its true worst case is unbounded unless the run itself is capped.
- **Decision**: Cap each run at `AGENT_RUN_TOKEN_LIMIT` tokens, across all its approvals, and reserve that much in Postgres in the transaction that opens the run, under a per-user advisory lock that also enforces `AGENT_MAX_CONCURRENT_RUNS`. Read the day's spent tokens and the held ones in one statement, so both come from one snapshot. Move each step's tokens from the run's reservation to `token_usage`, and to the run's own total, in one transaction, stop the run before a step that could pass its reservation, and free the rest when it ends, pauses, or goes stale. A decision on an approval claims the paused run first, then reserves what the run has left of its limit. If the budget can't cover that, the run ends with reason `budget_exceeded` instead of staying paused. Budgets stay in tokens, as in [decision 004](004-keep-budgets-and-runs-in-postgres.md).
- **Consequences**:
  - Concurrent runs, on any number of instances, can't spend more than the budget, except by a step whose input outgrows the projection.
  - A user can't start a run with less than `AGENT_RUN_TOKEN_LIMIT` left today, so the budget should be several times the limit.
  - A run that hits its limit ends as `incomplete` with reason `token_limit`.
  - A decline can't be blocked by the budget: at worst it ends the run without the model's reply, and frees the thread.
  - A crashed process holds its runs' reservations until they go stale, `AGENT_RUN_TIMEOUT_MS` plus 30 seconds.
  - Rejected: reserving only what's left of the budget, which lets a near-empty budget start runs it can't pay for, and per-request token counting calls, which add a round trip per step.
