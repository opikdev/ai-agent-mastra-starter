# 009. Fail closed when the guardrail fails

- **Status**: accepted
- **Context**: Mastra's prompt injection detector let a message through when its own model call failed, and said so only on the console. An outage at the guardrail's provider, or an attacker who can make the check fail, then turned the check off without anyone noticing.
- **Decision**: Run the detector in Mastra's `strict` error mode by default, so a failed check blocks the message. The guardrail's model wrapper tells the run when its call failed, so the run ends as `failed` with reason `guardrail_unavailable` and a 503 problem, not as a `blocked` verdict. `GUARDRAIL_ON_ERROR=allow` restores the old behavior. Both log a `guardrail.failed` warning.
- **Consequences**:
  - A guardrail outage makes the agent unavailable, which the problem says, instead of unguarded.
  - Operators can alert on one log event, whichever mode they run.
  - The wrapper strips the request body from the error before Mastra prints it, so the message isn't logged.
  - It relies on the detector's `errorStrategy` option, which `test/integration/guardrails.test.ts` covers.
