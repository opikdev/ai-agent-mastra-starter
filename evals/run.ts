import { runEvals } from '@mastra/core/evals';
import { Mastra } from '@mastra/core/mastra';
import type { RequestContext } from '@mastra/core/request-context';
import { InMemoryStore } from '@mastra/core/storage';
import { runOptions } from '../src/agent/context.ts';
import { agentId, createNotesAssistant } from '../src/agent/notes-assistant.ts';
import type { Config } from '../src/config.ts';
import { createNotesClient } from '../src/notes/client.ts';
import { createFakeNotesApi } from '../test/fake-notes-api.ts';
import type { EvalCase } from './cases.ts';

export interface CaseResult {
  name: string;
  passed: boolean;
  failedGates: string[];
}

export interface EvalReport {
  results: CaseResult[];
  passRate: number;
}

type EvalConfig = Pick<
  Config,
  | 'AGENT_MODEL'
  | 'GUARDRAIL_MODEL'
  | 'AGENT_MEMORY_MESSAGES'
  | 'AGENT_MAX_STEPS'
  | 'AGENT_MAX_OUTPUT_TOKENS'
>;

interface RunOptions {
  config: EvalConfig;
  cases: EvalCase[];
  onResult?: (result: CaseResult) => void;
}

/** Runs each case against the real agent, with a fake notes API seeded for that case. */
export async function runCases({ config, cases, onResult }: RunOptions): Promise<EvalReport> {
  const assistant = createNotesAssistant({
    model: config.AGENT_MODEL,
    guardrailModel: config.GUARDRAIL_MODEL,
    memoryMessages: config.AGENT_MEMORY_MESSAGES,
  });
  const limits = {
    maxSteps: config.AGENT_MAX_STEPS,
    maxOutputTokens: config.AGENT_MAX_OUTPUT_TOKENS,
  };
  const mastra = new Mastra({
    agents: { [agentId]: assistant },
    storage: new InMemoryStore(),
    logger: false,
  });
  const agent = mastra.getAgent(agentId);
  const notesApi = createFakeNotesApi();
  const results: CaseResult[] = [];

  for (const [index, testCase] of cases.entries()) {
    const userId = `usr_eval_${index}`;
    const token = `eval-token-${index}`;
    notesApi.addUser(userId, token);
    notesApi.notes.set(
      userId,
      testCase.notes.map((note, position) => ({
        id: `note_${index}_${position}`,
        ...note,
        version: 1,
        createdAt: '2026-11-01T00:00:00.000Z',
        updatedAt: '2026-11-01T00:00:00.000Z',
      })),
    );
    const notes = createNotesClient({
      baseUrl: 'http://notes.eval',
      token,
      timeoutMs: 5000,
      fetch: notesApi.fetch,
    });
    const { requestContext, ...targetOptions } = runOptions({
      context: { userId, notes },
      threadId: `thr_eval_${index}`,
      limits,
    });

    const outcome = await runEvals({
      target: agent,
      // runEvals types each item's request context as untyped.
      data: [{ input: testCase.input, requestContext: requestContext as RequestContext }],
      gates: testCase.gates,
      targetOptions,
    });
    const failedGates = (outcome.gateResults ?? [])
      .filter((gate) => !gate.passed)
      .map((gate) => gate.id);
    const result = { name: testCase.name, passed: outcome.verdict === 'passed', failedGates };
    results.push(result);
    onResult?.(result);
  }

  await mastra.shutdown();
  const passed = results.filter((result) => result.passed).length;
  return { results, passRate: results.length === 0 ? 0 : passed / results.length };
}
