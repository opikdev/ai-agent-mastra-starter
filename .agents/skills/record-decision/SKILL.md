---
name: record-decision
description: Record a significant technical decision as an ADR in docs/decisions/. Use when choosing a framework, schema, or architecture, or when rejecting an alternative that someone is likely to suggest again.
---

# Record a decision

1. Find the highest number in `docs/decisions/` and add one.
2. Create `docs/decisions/NNN-short-title.md` with these fields:

   ```markdown
   # NNN. Short title

   - **Status**: accepted
   - **Context**: 2–3 lines on the problem and constraints
   - **Decision**: 1–2 lines
   - **Consequences**:
     - What gets easier or harder
   ```

3. Run `.agents/check.sh`.
