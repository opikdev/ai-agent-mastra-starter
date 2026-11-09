# 001. Run Mastra behind our own API

- **Status**: accepted
- **Context**: Mastra brings an agent loop, memory, approvals, guardrails, evals, and tracing, which would take months to rebuild well. Its server adapter exposes every Mastra route, including ones to edit agents and read any thread, with auth that's easy to get wrong. Mastra Studio needs a user context the tools can't get outside a request.
- **Decision**: Use Mastra as a library. Serve a small Hono API that owns auth, limits, errors, and streaming, and calls `agent.stream()`. Don't ship Studio or the Mastra server routes.
- **Consequences**:
  - The public surface is a handful of routes we test, with Problem Details errors like the other starters.
  - Mastra upgrades touch `src/agent/` and the relay, not the API contract.
  - There's no local Studio UI. The API, tests, and evals replace it.
