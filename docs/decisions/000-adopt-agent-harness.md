# 000. Adopt the agent harness

- **Status**: accepted
- **Context**: Coding agents need the same project map and rules in every session, and written rules drift unless something enforces them.
- **Decision**: Use `AGENTS.md` as a short map, keep detail in `docs/`, and enforce the structure with `.agents/check.sh` in a pre-commit hook and CI.
- **Consequences**:
  - Agents and people start from the same map.
  - A broken link or incomplete ADR blocks the commit until it's fixed.
