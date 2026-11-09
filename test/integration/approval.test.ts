import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createMastra } from '../../src/agent/mastra.ts';
import { createApp } from '../../src/app.ts';
import { createDb, createPool } from '../../src/db/client.ts';
import { createLogger } from '../../src/http/logger.ts';
import { eventsOf, readSse, startStack, type TestStack, type TestUser } from '../helpers.ts';

let stack: TestStack;
beforeAll(async () => {
  stack = await startStack();
});
afterAll(() => stack.close());

async function askToDelete(user: TestUser) {
  stack.notesApi.notes.set(user.id, [
    { id: 'note_1', title: 'Old', body: 'x', version: 1, createdAt: 'x', updatedAt: 'x' },
  ]);
  const thread = await user.createThread();
  stack.reply({ tool: { name: 'deleteNote', input: { id: 'note_1' } } });
  const events = await user.say(thread.id, 'Delete my note Old');
  const [approval] = eventsOf(events, 'approval-required');
  return { thread, events, approval };
}

describe('tool approval', () => {
  it('pauses a delete until the user approves it, then runs it', async () => {
    const user = stack.signUp();
    const { events, approval } = await askToDelete(user);
    expect(approval).toMatchObject({ toolName: 'deleteNote', args: { id: 'note_1' } });
    expect(eventsOf(events, 'done')[0]).toMatchObject({
      runId: approval.runId,
      status: 'awaiting_approval',
    });
    expect(stack.notesApi.notes.get(user.id)).toHaveLength(1);

    stack.reply({ text: 'Deleted it.' });
    const resumed = await user.decide(approval.runId, approval.toolCallId, true);
    expect(eventsOf(resumed, 'tool-result')[0].result).toEqual({ deleted: 'note_1' });
    expect(eventsOf(resumed, 'done')[0]).toMatchObject({ status: 'completed' });
    expect(stack.notesApi.notes.get(user.id)).toHaveLength(0);
  });

  it('tells the model the reason when the user declines', async () => {
    const user = stack.signUp();
    const { approval } = await askToDelete(user);
    stack.reply({ text: 'Okay, I kept it.' });
    const resumed = await user.decide(approval.runId, approval.toolCallId, false, 'Keep it');
    expect(eventsOf(resumed, 'done')[0]).toMatchObject({ status: 'completed' });
    expect(stack.notesApi.notes.get(user.id)).toHaveLength(1);
    expect(JSON.stringify(stack.anthropic.requests.at(-1)?.messages)).toContain('Keep it');
  });

  it('counts the paused step once, not again when it resumes', async () => {
    const user = stack.signUp();
    const { approval } = await askToDelete(user);
    stack.reply({ text: 'Deleted.' });
    const resumed = await user.decide(approval.runId, approval.toolCallId, true);
    expect(eventsOf(resumed, 'done')[0].usage).toEqual({ inputTokens: 100, outputTokens: 20 });
    const usage = await (await user.request('/v1/usage')).json();
    expect(usage).toMatchObject({ inputTokens: 200, outputTokens: 40 });
  });

  it('refuses a new message while an approval is pending', async () => {
    const user = stack.signUp();
    const { thread } = await askToDelete(user);
    const response = await user.request(`/v1/threads/${thread.id}/messages`, {
      method: 'POST',
      json: { content: 'Something else' },
    });
    expect(response.status).toBe(409);
    expect((await response.json()).type).toBe('urn:problem:approval-pending');
  });

  it('runs an approval once, even when it arrives twice', async () => {
    const user = stack.signUp();
    const { approval } = await askToDelete(user);
    stack.reply({ text: 'Deleted.' });
    const responses = await Promise.all(
      [1, 2].map(() =>
        user.request(`/v1/runs/${approval.runId}/approval`, {
          method: 'POST',
          json: { toolCallId: approval.toolCallId, approved: true },
        }),
      ),
    );
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    await Promise.all(responses.map((response) => response.text()));
  });

  it('hides another user’s run', async () => {
    const owner = stack.signUp();
    const { approval } = await askToDelete(owner);
    const intruder = stack.signUp();
    const response = await intruder.request(`/v1/runs/${approval.runId}/approval`, {
      method: 'POST',
      json: { toolCallId: approval.toolCallId, approved: true },
    });
    expect(response.status).toBe(404);
    expect(stack.notesApi.notes.get(owner.id)).toHaveLength(1);
  });

  it.each([
    ['an unknown run', 'run_00000000000000000000000000000000'],
    ['a malformed run ID', 'junk'],
  ])('returns 404 for %s', async (_label, runId) => {
    const user = stack.signUp();
    const response = await user.request(`/v1/runs/${runId}/approval`, {
      method: 'POST',
      json: { toolCallId: 'x', approved: true },
    });
    expect(response.status).toBe(404);
  });

  it('rejects a tool call ID that isn’t the pending one', async () => {
    const user = stack.signUp();
    const { approval } = await askToDelete(user);
    const response = await user.request(`/v1/runs/${approval.runId}/approval`, {
      method: 'POST',
      json: { toolCallId: 'toolu_other', approved: true },
    });
    expect(response.status).toBe(409);
    expect((await response.json()).type).toBe('urn:problem:approval-not-pending');
  });

  it('survives a restart between the pause and the approval', async () => {
    const user = stack.signUp();
    const { approval } = await askToDelete(user);

    const pool = createPool(stack.config.DATABASE_URL, 5000);
    const { mastra, agent } = createMastra(stack.config, pool);
    const restarted = createApp({
      config: stack.config,
      db: createDb(pool),
      logger: createLogger('silent'),
      agent,
      fetch: stack.notesApi.fetch,
    });
    stack.reply({ text: 'Deleted.' });
    const response = await restarted.request(`/v1/runs/${approval.runId}/approval`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${user.token}`,
        'Content-Type': 'application/json',
        'X-Forwarded-For': 'restart-test',
      },
      body: JSON.stringify({ toolCallId: approval.toolCallId, approved: true }),
    });
    expect(eventsOf(await readSse(response), 'done')[0]).toMatchObject({ status: 'completed' });
    expect(stack.notesApi.notes.get(user.id)).toHaveLength(0);
    await mastra.shutdown();
    await pool.end();
  });

  it('never stores the caller’s token in the paused run', async () => {
    const user = stack.signUp();
    await askToDelete(user);
    const client = new pg.Client({ connectionString: inject('ownerDatabaseUrl') });
    await client.connect();
    try {
      const { rows } = await client.query<{ hits: number }>(
        `select count(*)::int as hits from mastra.mastra_workflow_snapshot where snapshot::text like $1`,
        [`%${user.token}%`],
      );
      const { rows: all } = await client.query<{ total: number }>(
        'select count(*)::int as total from mastra.mastra_workflow_snapshot',
      );
      expect(all[0]?.total).toBeGreaterThan(0);
      expect(rows[0]?.hits).toBe(0);
    } finally {
      await client.end();
    }
  });
});
