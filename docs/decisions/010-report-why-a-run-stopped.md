# 010. Report why a run stopped

- **Status**: accepted
- **Context**: Every run that streamed to the end was `completed`, including replies cut off at the output cap, refusals, and runs that used up their steps. Clients showed a truncated answer as a finished one, and the run record couldn't tell them apart.
- **Decision**: Map the model's finish reason to the run's status: `length` to `incomplete` with reason `max_tokens` or `context_window`, `content-filter` to `refused`, and a run that ends on a tool call to `incomplete` with `max_steps` or `token_limit`. Send the status and a `reason` in the `done` event, and save both on the run row. Make the output cap a setting, 16,000 by default, so adaptive thinking fits.
- **Consequences**:
  - Clients can tell a full answer from a partial one, and ask the user to continue or rephrase.
  - Clients that treated every non-`completed` status as an error now see new ones, so the change is breaking.
  - Aborted runs keep `failed` in Postgres, with the reason, because nothing reads an aborted run back.
