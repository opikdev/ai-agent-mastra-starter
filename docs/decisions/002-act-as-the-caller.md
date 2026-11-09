# 002. Act as the caller

- **Status**: accepted
- **Context**: An agent with a shared service credential can read or change any user's data, so a prompt injection in one note could reach everyone's. A separate login for the agent would duplicate the app's users and sessions.
- **Decision**: Accept the app's own bearer tokens. Check each one with the app's `GET /v1/users/me`, cache the answer for 30 seconds, and run every tool with the same token.
- **Consequences**:
  - The agent can never do more than the user can, and the app's own authorization still applies.
  - The agent needs the app to be up, so an app outage returns 503.
  - A revoked token keeps working for up to 30 seconds.
  - The token is held in memory for the request only. Tests check that it never reaches Postgres or traces.
