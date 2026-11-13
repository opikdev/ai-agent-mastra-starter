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
    stack.reply({ tool: { name: 'listNotes', input: {} } }, { text: 'You have no notes yet.' });
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

  it('leaves messages and replies out of spans by default', () => {
    const exported = received.map((request) => request.body).join('\n');
    expect(exported).not.toContain('List my notes');
    expect(exported).not.toContain('You have no notes yet');
  });
});

describe('tracing with content capture on', () => {
  it('puts the prompt in the spans', async () => {
    received.length = 0;
    const { port } = collector.address() as AddressInfo;
    const capturing = await startStack({
      OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}`,
      OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: 'true',
    });
    const user = capturing.signUp();
    const thread = await user.createThread();
    await user.say(thread.id, 'Find my grocery list');
    await capturing.close();
    const exported = received.map((request) => request.body).join('\n');
    expect(exported).toContain('Find my grocery list');
  });
});
