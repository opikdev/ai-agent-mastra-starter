# 003. Default to Sonnet 5.5, with Haiku 5.5 guardrails

- **Status**: accepted
- **Context**: Agent quality depends mostly on tool choice, where Sonnet 5.5 is strong at half of Opus 5.5's price. A prompt injection check runs on every message, so it has to be cheap and fast.
- **Decision**: Default `AGENT_MODEL` to `anthropic/claude-sonnet-5-5` and `GUARDRAIL_MODEL` to `anthropic/claude-haiku-5-5` at low effort. Both are one variable away from any Mastra model.
- **Consequences**:
  - A message costs one Haiku call more than it would without the guardrail.
  - Claude 5.5 models reject sampling settings, forced tool choice, and prefill, so the code never sends them. A test checks the request.
  - The guardrail fails open when Haiku is down, so approvals and acting as the caller stay the main defense.
