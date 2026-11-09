import { loadConfig } from '../src/config.ts';
import { cases } from './cases.ts';
import { runCases } from './run.ts';

const threshold = Number(process.env.EVAL_THRESHOLD ?? '0.85');
if (!process.env.ANTHROPIC_API_KEY) {
  console.error(
    'Set ANTHROPIC_API_KEY to run the evals against the real model. They cost under $0.25.',
  );
  process.exit(2);
}

const config = loadConfig({
  DATABASE_URL: 'postgres://unused@localhost/unused',
  NOTES_API_URL: 'http://notes.eval',
  ...process.env,
});

console.log(`Running ${cases.length} cases against ${config.AGENT_MODEL}\n`);
const report = await runCases({
  config,
  cases,
  onResult: ({ name, passed, failedGates }) => {
    console.log(
      `${passed ? 'pass' : 'FAIL'}  ${name}${passed ? '' : `  (${failedGates.join(', ')})`}`,
    );
  },
});

const percent = (value: number) => `${Math.round(value * 100)}%`;
console.log(`\n${percent(report.passRate)} passed. The threshold is ${percent(threshold)}.`);
process.exit(report.passRate >= threshold ? 0 : 1);
