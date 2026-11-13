# 011. Turn the API docs off by default

- **Status**: accepted
- **Context**: An OpenAPI document and Swagger UI help clients integrate, but they map a private API for attackers, and Swagger UI loaded from a CDN puts a third-party script on the API's origin.
- **Decision**: Generate the document from the routes, and serve `/openapi.json` and `/docs` only when `DOCS_ENABLED=true`, from `swagger-ui-dist` pinned in `package.json`, under a CSP that allows only the agent's own origin. Commit `openapi.json`, and fail the tests when it drifts.
- **Consequences**:
  - A production deploy publishes nothing about the API unless someone turns the docs on.
  - `.env.example` and Compose turn the docs on, so the quick start still shows them.
  - Swagger UI updates come through Renovate, and the image is bigger.
