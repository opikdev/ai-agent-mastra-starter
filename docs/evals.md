# Evals

Evals check that the agent picks the right tools for realistic requests. Each case seeds a fake notes API, sends one message, and checks the result with [Mastra checks](https://mastra.ai/docs/evals/quick-checks), such as `calledTool` or `includes`.

## Run them

| Command | Model | Cost | Runs in |
|---|---|---|---|
| `pnpm test` | Fake, with scripted golden replies | Free | Every CI run |
| `pnpm eval` | `AGENT_MODEL`, the real one | Under $0.25 | By hand, and the `Evals` workflow |

`pnpm test` proves the cases, checks, and runner work. It can't tell you whether the model behaves, because the replies are scripted.

`pnpm eval` sends each case to the real model, with the same `AGENT_*` settings and run options as the API, and prints pass or fail for each. It exits with 1 when the pass rate is below `EVAL_THRESHOLD`, 0.85 by default. Models vary from run to run, so a single failure isn't always a regression. Rerun before you change anything.

## Add a case

1. Add it to `evals/cases.ts`, with the notes to seed, the message, and the gates.
2. Use each check type once per case. Mastra keys results by check type, so a second `didNotCall` would share the first one's result. A test enforces this.
3. Add the golden replies in the same position in `test/unit/evals.test.ts`.
4. Run `pnpm test`, then `pnpm eval`.

## Run them in CI

The `Evals` workflow runs `pnpm eval` weekly and on demand. It needs an `ANTHROPIC_API_KEY` repository secret, and skips without one.
