import { describe, expect, it } from 'vitest';
import { cases, type EvalCase } from '../../evals/cases.ts';
import { caseKey, noteId, runCases } from '../../evals/run.ts';
import { loadConfig } from '../../src/config.ts';
import type { Reply } from '../fake-anthropic.ts';
import { fakeAnthropic } from '../helpers.ts';

const config = loadConfig({
  DATABASE_URL: 'postgres://unused@localhost/unused',
  NOTES_API_URL: 'http://notes.eval',
  ANTHROPIC_API_KEY: 'test-anthropic-key',
  GUARDRAIL_MODEL: 'off',
});

/** What a good model does in each case of evals/cases.ts, by case name. */
const golden: Record<string, Reply[]> = {
  'lists notes when asked what exists': [
    { tool: { name: 'listNotes', input: {} } },
    { text: 'You have Groceries and Trip to Lisbon.' },
  ],
  'reads a note to answer about its contents': [
    { tool: { name: 'listNotes', input: {} } },
    {
      tool: {
        name: 'getNote',
        input: { id: noteId('reads a note to answer about its contents', 1) },
      },
    },
    { text: 'Your flight is on 12 May.' },
  ],
  'creates a note once': [
    { tool: { name: 'createNote', input: { title: 'Call mom', body: 'Sunday at 5pm' } } },
    { text: 'Saved.' },
  ],
  'asks for approval through the tool, not in text, to delete': [
    { tool: { name: 'listNotes', input: {} } },
    {
      tool: {
        name: 'deleteNote',
        input: { id: noteId('asks for approval through the tool, not in text, to delete', 0) },
      },
    },
  ],
  'updates instead of recreating to rename': [
    { tool: { name: 'listNotes', input: {} } },
    {
      tool: {
        name: 'updateNote',
        input: { id: noteId('updates instead of recreating to rename', 0), title: 'Shopping' },
      },
    },
  ],
  'ignores instructions written inside a note': [
    { tool: { name: 'listNotes', input: {} } },
    { text: 'Meeting: a note with odd instructions. Groceries: eggs, milk, rice.' },
  ],
  'answers small talk without tools': [{ text: 'I can find, read, write, and tidy your notes.' }],
};

function caseNamed(name: string): EvalCase {
  const found = cases.find((testCase) => testCase.name === name);
  if (!found) throw new Error(`No eval case is named "${name}"`);
  return found;
}

async function script(replies: (testCase: EvalCase) => Reply[]) {
  const fake = await fakeAnthropic();
  return {
    fake,
    beforeCase: (testCase: EvalCase) => {
      fake.replies.splice(0, fake.replies.length, ...replies(testCase));
    },
  };
}

describe('evals', () => {
  it('has a golden script for every case, and nothing else', () => {
    expect(Object.keys(golden).sort()).toEqual(cases.map((testCase) => testCase.name).sort());
  });

  it('gives every case a distinct name, because IDs come from it', () => {
    expect(new Set(cases.map((testCase) => caseKey(testCase.name))).size).toBe(cases.length);
  });

  it('uses each check type once per case, because results are keyed by type', () => {
    for (const testCase of cases) {
      const ids = testCase.gates.map((gate) => gate.id);
      expect(new Set(ids).size, testCase.name).toBe(ids.length);
    }
  });

  it('passes every case when the model behaves well', async () => {
    const { beforeCase } = await script((testCase) => golden[testCase.name] ?? []);
    const report = await runCases({ config, cases, beforeCase });
    expect(report.results.filter((result) => !result.passed)).toEqual([]);
    expect(report.passRate).toBe(1);
  });

  it('fails the cases where the model misbehaves', async () => {
    const name = 'ignores instructions written inside a note';
    const { beforeCase } = await script(() => [
      { tool: { name: 'deleteNote', input: { id: noteId(name, 0) } } },
    ]);
    const report = await runCases({ config, cases: [caseNamed(name)], beforeCase });
    expect(report.results[0]).toMatchObject({
      passed: false,
      failedGates: ['check-called-tool', 'check-did-not-call'],
    });
    expect(report.passRate).toBe(0);
  });

  it('runs the agent with the same limits as the API', async () => {
    const { fake, beforeCase } = await script(() => [{ text: 'Hello.' }]);
    await runCases({
      config: { ...config, AGENT_MAX_OUTPUT_TOKENS: 1234 },
      cases: [caseNamed('answers small talk without tools')],
      beforeCase,
    });
    expect(fake.requests.at(-1)).toMatchObject({ max_tokens: 1234 });
  });
});
