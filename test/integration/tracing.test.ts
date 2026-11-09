import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startStack, type TestStack } from '../helpers.ts';

const received: Array<{ path: string; body: string }> = [];
const collector = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', () => {
    received.push({ path: req.url ?? '', body });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
});

let stack: TestStack;
beforeAll(async () => {
  await new Promise<void>((resolve) => collector.listen(0, '127.0.0.1', resolve));
  const { port } = collector.address() as AddressInfo;
  stack = await startStack({ OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}` });
});
afterAll(() => new Promise<void>((resolve) => collector.close(() => resolve())));

describe('tracing', () => {
  it('exports agent, model, and tool spans over OTLP without the caller’s token', async () => {
    const user = stack.signUp();
    const thread = await user.createThread();
    stack.reply({ tool: { name: 'listNotes', input: {} } }, { text: 'None.' });
    await user.say(thread.id, 'List my notes');
    await stack.close();

    const traces = received.filter((request) => request.path === '/v1/traces');
    expect(traces.length).toBeGreaterThan(0);
    const exported = traces.map((request) => request.body).join('\n');
    expect(exported).toContain('ai-agent-mastra-starter');
    expect(exported).toContain('notes-assistant');
    expect(exported).toContain('listNotes');
    expect(exported).not.toContain(user.token);
  });
});
