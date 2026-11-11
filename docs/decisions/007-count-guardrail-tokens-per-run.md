# 007. Count guardrail tokens through a per-run model

- **Status**: accepted
- **Context**: The prompt injection check calls Haiku on every message, but Mastra's detector drops that call's usage, so the budget missed it. Runs execute concurrently in one process, so the tokens must reach the run that spent them, and a blocked run must still record them.
- **Decision**: Give the detector a dynamic model. For each call, it reads the run's recorder from the request context and wraps Mastra's model router so that each response's usage goes to that recorder. The run adds it up in memory and saves it to `token_usage` when the run ends, because the detector lets a message through when its call fails, so a database error must never reach it. Budgets stay in tokens, as in [decision 004](004-keep-budgets-and-runs-in-postgres.md), with the guardrail's share stored and reported apart from the agent's.
- **Consequences**:
  - Usage is exact and scoped to one run, with no shared state between runs.
  - A process that dies mid-run loses that run's guardrail tokens, at most one check's worth.
  - A Haiku token uses as much budget as a Sonnet token. Callers that want dollars price the `agent` and `guardrail` split themselves.
  - It relies on two Mastra details: the detector's agent accepts a dynamic model that its options type leaves out, and the router passes on the provider's v3 usage. Tests in `test/unit/guardrail-usage.test.ts` and `test/integration/guardrails.test.ts` fail if either changes.
  - Rejected: a dollar budget with a price table, and `AsyncLocalStorage` around the detector, which adds a second way to pass run state.
