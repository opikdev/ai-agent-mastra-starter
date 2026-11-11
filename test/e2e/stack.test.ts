import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type FakeAnthropic, startFakeAnthropic } from '../fake-anthropic.ts';
import { readSse } from '../helpers.ts';

const port = process.env.E2E_PORT ?? '3300';
const notesPort = process.env.E2E_NOTES_PORT ?? '3301';
const anthropicPort = 4320;
const otlpPort = 4321;
const agentUrl = `http://127.0.0.1:${port}`;
const notesUrl = `http://127.0.0.1:${notesPort}`;
const composeEnv = {
  ...process.env,
  PORT: port,
  NOTES_API_PORT: notesPort,
  POSTGRES_PORT: process.env.E2E_DB_PORT ?? '5632',
  ANTHROPIC_API_KEY: 'e2e-key',
  ANTHROPIC_BASE_URL: `http://host.docker.internal:${anthropicPort}/v1`,
  OTEL_EXPORTER_OTLP_ENDPOINT: `http://host.docker.internal:${otlpPort}`,
  COMPOSE_PROJECT_NAME: 'ai-agent-mastra-starter-e2e',
};

function compose(...args: string[]): string {
  return execFileSync('docker', ['compose', ...args], {
    env: composeEnv,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out after ${timeoutMs} ms`);
}

let anthropic: FakeAnthropic;
let collector: Server;
let traces = '';
let token = '';

function agent(path: string, init: RequestInit = {}) {
  return fetch(`${agentUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...init.headers,
    },
  });
}

beforeAll(async () => {
  anthropic = await startFakeAnthropic([], { host: '0.0.0.0', port: anthropicPort });
  collector = createServer((request, response) => {
    request.on('data', (chunk: Buffer) => {
      if (request.url === '/v1/traces') traces += chunk.toString();
    });
    request.on('end', () => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('{}');
    });
  });
  await new Promise<void>((resolve) => collector.listen(otlpPort, '0.0.0.0', resolve));

  compose('down', '--volumes', '--remove-orphans');
  compose('up', '--build', '--detach', '--wait', 'agent');

  const session = await fetch(`${notesUrl}/v1/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'demo@example.com', password: 'demo-password-123' }),
  });
  token = ((await session.json()) as { token: string }).token;
});

afterAll(async () => {
  compose('down', '--volumes', '--remove-orphans');
  await anthropic.close();
  await new Promise((resolve) => collector.close(resolve));
});

describe('the running stack', () => {
  it('is ready after one command, as a non-root user', async () => {
    expect((await fetch(`${agentUrl}/readyz`)).status).toBe(200);
    expect(JSON.parse(compose('ps', 'agent', '--format', 'json').trim()).Health).toBe('healthy');
    expect(compose('exec', '-T', 'agent', 'id', '-u').trim()).not.toBe('0');
  });

  it('rejects a token the example notes API doesn’t know', async () => {
    const response = await fetch(`${agentUrl}/v1/threads`, {
      headers: { Authorization: 'Bearer nope' },
    });
    expect(response.status).toBe(401);
  });

  it('reads the example notes API as the signed-in user', async () => {
    const thread = (await (await agent('/v1/threads', { method: 'POST', body: '{}' })).json()) as {
      id: string;
    };
    anthropic.replies.push(
      { tool: { name: 'listNotes', input: {} } },
      { text: 'You have two notes.' },
    );
    const events = await readSse(
      await agent(`/v1/threads/${thread.id}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: 'What notes do I have?' }),
      }),
    );
    const result = events.find((event) => event.event === 'tool-result')?.data.result;
    expect(result.notes.map((note: { title: string }) => note.title).sort()).toEqual([
      'Try the API',
      'Welcome',
    ]);
  });

  it('deletes a note only after approval, even across a restart', async () => {
    const notes = (await (
      await fetch(`${notesUrl}/v1/notes`, { headers: { Authorization: `Bearer ${token}` } })
    ).json()) as { data: Array<{ id: string; title: string }> };
    const target = notes.data.find((note) => note.title === 'Welcome');
    if (!target) throw new Error('The seeded Welcome note is missing');

    const thread = (await (await agent('/v1/threads', { method: 'POST', body: '{}' })).json()) as {
      id: string;
    };
    anthropic.replies.push({ tool: { name: 'deleteNote', input: { id: target.id } } });
    const paused = await readSse(
      await agent(`/v1/threads/${thread.id}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: 'Delete Welcome' }),
      }),
    );
    const approval = paused.find((event) => event.event === 'approval-required')?.data;
    expect(approval).toMatchObject({ toolName: 'deleteNote' });

    compose('restart', 'agent');
    await waitFor(
      async () => (await fetch(`${agentUrl}/readyz`).catch(() => null))?.status === 200,
    );

    anthropic.replies.push({ text: 'Deleted.' });
    const resumed = await readSse(
      await agent(`/v1/runs/${approval.runId}/approval`, {
        method: 'POST',
        body: JSON.stringify({ toolCallId: approval.toolCallId, approved: true }),
      }),
    );
    expect(resumed.at(-1)?.data).toMatchObject({ status: 'completed' });
    const gone = await fetch(`${notesUrl}/v1/notes/${target.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(gone.status).toBe(404);
  });

  it('ends a run as aborted when the agent restarts mid-answer, and frees the thread', async () => {
    const thread = (await (await agent('/v1/threads', { method: 'POST', body: '{}' })).json()) as {
      id: string;
    };
    const send = (content: string) =>
      agent(`/v1/threads/${thread.id}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content }),
      }).then(readSse);
    const before = anthropic.requests.length;
    anthropic.delayMs = 20_000;
    const interrupted = send('Write me a long story');
    await waitFor(() => anthropic.requests.length > before);

    compose('restart', 'agent');
    const events = await interrupted;
    anthropic.delayMs = 0;
    expect(events.find((event) => event.event === 'error')?.data.detail).toContain('shut down');
    expect(events.at(-1)?.data).toMatchObject({ status: 'aborted' });

    await waitFor(
      async () => (await fetch(`${agentUrl}/readyz`).catch(() => null))?.status === 200,
    );
    anthropic.replies.push({ text: 'Back again.' });
    expect((await send('Are you there?')).at(-1)?.data).toMatchObject({ status: 'completed' });
  });

  it('checks messages with the guardrail model', () => {
    expect(anthropic.guardRequests.length).toBeGreaterThan(0);
    expect(anthropic.guardRequests[0]?.model).toBe('claude-haiku-5-5');
  });

  it('exports traces over OTLP without the user’s token', async () => {
    compose('stop', 'agent');
    await waitFor(() => traces.includes('notes-assistant'));
    expect(traces).not.toContain(token);
  });
});
