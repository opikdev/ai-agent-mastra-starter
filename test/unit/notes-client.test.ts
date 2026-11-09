import { describe, expect, it } from 'vitest';
import { createNotesClient, UpstreamError } from '../../src/notes/client.ts';
import { createFakeNotesApi } from '../fake-notes-api.ts';

function setup() {
  const api = createFakeNotesApi();
  api.addUser('usr_1', 'good-token');
  const client = createNotesClient({
    baseUrl: 'http://notes.test/',
    token: 'good-token',
    timeoutMs: 1000,
    fetch: api.fetch,
  });
  return { api, client };
}

async function failure(promise: Promise<unknown>): Promise<UpstreamError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(UpstreamError);
  return error as UpstreamError;
}

describe('notes client', () => {
  it('creates, reads, updates with If-Match, lists, and deletes', async () => {
    const { client } = setup();
    const note = await client.create({ title: 'A', body: 'x' });
    expect(await client.get(note.id)).toMatchObject({ title: 'A' });
    expect(await client.update(note.id, { body: 'y' })).toMatchObject({ title: 'A', body: 'y' });
    expect((await client.list({ limit: 10 })).data).toHaveLength(1);
    await client.remove(note.id);
    expect((await client.list({ limit: 10, cursor: undefined })).data).toHaveLength(0);
    expect(await client.me()).toEqual({ id: 'usr_1' });
  });

  it('pages with the cursor', async () => {
    const { client } = setup();
    for (const title of ['A', 'B', 'C']) await client.create({ title, body: '' });
    const first = await client.list({ limit: 2 });
    const second = await client.list({ limit: 2, cursor: first.meta.nextCursor ?? undefined });
    expect([...first.data, ...second.data].map((note) => note.title)).toEqual(['C', 'B', 'A']);
  });

  it.each([
    [401, 'rejected the credentials'],
    [404, 'Failure.'],
    [412, 'changed while updating'],
    [422, 'refused the request: Failure.'],
    [503, 'failed with HTTP 503'],
  ])('explains HTTP %i for the model', async (status, message) => {
    const { api, client } = setup();
    api.failNext(status);
    const error = await failure(client.list({ limit: 1 }));
    expect(error.status).toBe(status);
    expect(error.message).toContain(message);
  });

  it('passes on Retry-After when rate limited', async () => {
    const { api, client } = setup();
    api.failNext(429, 'Slow down.', { 'Retry-After': '7' });
    expect((await failure(client.list({ limit: 1 }))).message).toContain('Retry in 7 seconds');
  });

  it('reports a timeout, an unreachable API, and a body it can’t read', async () => {
    const slow = createNotesClient({
      baseUrl: 'http://notes.test',
      token: 't',
      timeoutMs: 10,
      fetch: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    });
    expect((await failure(slow.me())).message).toContain('within 0.01 seconds');

    const down = createNotesClient({
      baseUrl: 'http://notes.test',
      token: 't',
      timeoutMs: 10,
      fetch: () => Promise.reject(new TypeError('fetch failed')),
    });
    expect((await failure(down.me())).message).toContain("Couldn't reach");

    const odd = createNotesClient({
      baseUrl: 'http://notes.test',
      token: 't',
      timeoutMs: 10,
      fetch: () => Promise.resolve(new Response('<html>', { status: 200 })),
    });
    expect((await failure(odd.me())).message).toContain("doesn't understand");
  });

  it('refuses to update a note that comes without an ETag', async () => {
    const client = createNotesClient({
      baseUrl: 'http://notes.test',
      token: 't',
      timeoutMs: 10,
      fetch: () => Promise.resolve(Response.json({ id: 'note_1' })),
    });
    expect((await failure(client.update('note_1', { title: 'x' }))).message).toContain('ETag');
  });

  it('never puts the token in an error message', async () => {
    const { api, client } = setup();
    api.failNext(500, 'good-token leaked');
    expect((await failure(client.me())).message).not.toContain('good-token');
  });
});
