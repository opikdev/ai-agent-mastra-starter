# Customize

## Change the model

Set `AGENT_MODEL` to any [Mastra model ID](https://mastra.ai/models), such as `anthropic/claude-opus-5-5`, and set that provider's API key. Run `pnpm eval` afterwards to check the agent still behaves.

Claude 5.5 models reject `temperature`, `top_p`, `top_k`, a forced `tool_choice`, and an assistant prefill. Don't add them in `modelSettings` or `providerOptions`.

## Change what the agent does

1. Edit `instructions` in `src/agent/notes-assistant.ts`.
2. Add or change eval cases in `evals/cases.ts`, and their golden replies, by case name, in `test/unit/evals.test.ts`.
3. Run `pnpm verify`, then `pnpm eval`.

## Add an agent

A deployment serves one agent: `createMastra()` in `src/agent/mastra.ts` returns it, and the routes call it for every thread. Threads don't record which agent they belong to, so a second agent on the same database would read the first one's threads as its own memory.

To run a second agent on its own:

1. Copy `src/agent/notes-assistant.ts`, and give the copy its own ID, instructions, tools, and guardrails. Keep `requestContextSchema`, or give it a schema of its own.
2. Return the new agent from `createMastra()`, and add its eval cases to `evals/cases.ts`.
3. Deploy it with its own database, so its threads, runs, and budgets stay apart.

To serve several agents from one deployment instead:

1. Register each agent in `createMastra()` under its ID, and pass them all to `createAgentRoutes()`.
2. Take an agent ID in `POST /v1/threads`, and save it with `createThread({ metadata: { agentId } })`.
3. In `ownThread()`, read `thread.metadata.agentId`, and run that agent for messages and approvals on the thread.
4. Test that each thread only ever runs its own agent, and document the new field in `docs/api.md`.

## Add a tool

1. Add a client method for the outside call, with a timeout, an optional `signal`, and a response schema, as in `src/notes/client.ts`. Throw `UpstreamError` with a message the model can act on.
2. Add the tool to `src/agent/tools.ts` with `createTool` and `requestContextSchema: agentContextSchema`. Read the client with `requestContext.get('notes')`, pass it the tool's `abortSignal` so a timed out or abandoned run cancels the call, and wrap the call in `attempt()` so failures return `{ error }`.
3. Set `requireApproval: true` if it changes or deletes data, or costs money.
4. Add it to `notesTools`.
5. Test it with a scripted reply in `test/integration/`, and add an eval case.

## Connect your own API

The agent trusts one API for identity and data. If your API meets the [notes API contract](notes-api.md), only point `NOTES_API_URL` at it, as [Use another API](notes-api.md#use-another-api) shows. Otherwise:

1. Point `NOTES_API_URL` at your API.
2. Change `me()` in `src/notes/client.ts` to your "who am I" endpoint. It must reject bad tokens with 401.
3. Replace the notes client methods and tools with your own.
4. Replace the example `notes-*` services in `compose.yaml` with your API, and update `test/fake-notes-api.ts`.
5. Update [docs/notes-api.md](notes-api.md) to describe your API's contract.

Callers keep sending your API's tokens, and tools keep acting as the caller.

If your users sign in with JWTs, you can verify them locally instead of calling `me()`. Use your identity provider's JWKS with a library such as `jose`, and keep forwarding the token to your API.

## Remember facts about a user

Mastra's [working memory](https://mastra.ai/docs/memory/working-memory) keeps a short profile per user across threads. Enable it in the `Memory` options in `src/agent/notes-assistant.ts`. The agent gets a tool to update it, which costs tokens on each turn.

## Add tools from an MCP server

Mastra's `MCPClient` from `@mastra/mcp` turns an MCP server's tools into agent tools. Pass the user's credentials per request, and mark tools that change data as needing approval. A shared credential would let every user act as that account.

## Change the guardrails

Input processors are in `guardrails()` in `src/agent/notes-assistant.ts`. Mastra also ships PII, moderation, and system prompt leak detectors, in `@mastra/core/processors`. Each LLM-based detector adds a model call per message. Give it `countedGuardrailModel(id)` from `src/agent/guardrail-usage.ts` as its model, so its tokens count toward the budget as guardrail tokens.

The prompt injection check fails open: if Haiku is down, messages go through. Approvals and acting as the user are the real defense, because they cap what an injected instruction can do.

## Upgrade Mastra

`@mastra/core` is pinned to an exact version, because `src/agent/relay.ts` and the evals rely on details that can change in any release: stream chunk shapes, the repeated usage after a resumed approval, the guardrail's dynamic model and its usage shape in `src/agent/guardrail-usage.ts`, and eval results keyed by check type. The other `@mastra/*` packages follow it.

1. Bump `@mastra/core` and the other `@mastra/*` packages together.
2. Read Mastra's changelog for stream, approval, memory, and storage changes.
3. Run `pnpm verify` and `pnpm test:e2e`, then `pnpm eval`.

## Rename the project

Create it with [pik](https://github.com/opikdev/pik): `pik new ai-agent-mastra-starter <name>`. It renames everything, installs dependencies, and formats the code.
