import { runEvals } from '@mastra/core/evals';
import { Mastra } from '@mastra/core/mastra';
import { RequestContext } from '@mastra/core/request-context';
import { InMemoryStore } from '@mastra/core/storage';
import { agentId, createNotesAssistant } from '../src/agent/notes-assistant.ts';
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

interface RunOptions {
  model: string;
  guardrailModel: string;
  cases: EvalCase[];
  onResult?: (result: CaseResult) => void;
}

/** Runs each case against the real agent, with a fake notes API seeded for that case. */
export async function runCases({
  model,
  guardrailModel,
  cases,
  onResult,
}: RunOptions): Promise<EvalReport> {
  const mastra = new Mastra({
    agents: { [agentId]: createNotesAssistant({ model, guardrailModel, memoryMessages: 20 }) },
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
    const requestContext = new RequestContext();
    requestContext.set('userId', userId);
    requestContext.set(
      'notes',
      createNotesClient({
        baseUrl: 'http://notes.eval',
        token,
        timeoutMs: 5000,
        fetch: notesApi.fetch,
      }),
    );

    const outcome = await runEvals({
      target: agent,
      data: [{ input: testCase.input, requestContext }],
      gates: testCase.gates,
      targetOptions: { maxSteps: 8, memory: { thread: `thr_eval_${index}`, resource: userId } },
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
