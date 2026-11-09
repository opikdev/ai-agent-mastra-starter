# 005. Test against a fake Messages API

- **Status**: accepted
- **Context**: Tests against a real model are slow, cost money, and change from run to run. Mastra's mock models skip the Anthropic provider, which is where request shape bugs live.
- **Decision**: Run tests against `test/fake-anthropic.ts`, a small HTTP server that speaks the Messages API, including streaming, tool use, and thinking signatures. Point Mastra at it with `ANTHROPIC_BASE_URL`. Keep real-model checks in `pnpm eval`.
- **Consequences**:
  - Tests are free and deterministic, and they cover the real provider code and request shape.
  - The fake can drift from the real API. Live evals and end-to-end runs catch that.
  - Mastra caches its provider, so a test file shares one fake server across its stacks.
