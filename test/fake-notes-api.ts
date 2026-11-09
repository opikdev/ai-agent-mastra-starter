import { Hono } from 'hono';

export interface FakeNote {
  id: string;
  title: string;
  body: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

type FakeEnv = { Variables: { userId: string } };

export interface FakeNotesApi {
  app: Hono<FakeEnv>;
  fetch: typeof fetch;
  /** Notes per user ID, newest first. */
  notes: Map<string, FakeNote[]>;
  /** Each request is recorded, and its signal can show whether the caller gave up. */
  requests: Request[];
  /** Holds each note request this long, until the caller's signal aborts. */
  delayMs: number;
  failNext: (status: number, detail?: string, headers?: Record<string, string>) => void;
  addUser: (userId: string, token: string) => void;
}

const timestamp = '2026-11-08T01:00:00.000Z';

function problem(status: number, detail: string, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify({ type: 'urn:problem:x', status, detail }), {
    status,
    headers: { 'Content-Type': 'application/problem+json', ...headers },
  });
}

export function createFakeNotesApi(): FakeNotesApi {
  const tokens = new Map<string, string>();
  const notes = new Map<string, FakeNote[]>();
  const requests: Request[] = [];
  let failure: { status: number; detail: string; headers: Record<string, string> } | null = null;
  let counter = 0;
  const app = new Hono<FakeEnv>();

  app.use(async (c, next) => {
    requests.push(c.req.raw.clone());
    if (api.delayMs > 0 && c.req.path.startsWith('/v1/notes')) {
      await new Promise((resolve, reject) => {
        setTimeout(resolve, api.delayMs);
        c.req.raw.signal.addEventListener('abort', () => reject(c.req.raw.signal.reason));
      });
    }
    if (failure) {
      const { status, detail, headers } = failure;
      failure = null;
      return problem(status, detail, headers);
    }
    const token = c.req.header('authorization')?.replace(/^Bearer /, '') ?? '';
    const userId = tokens.get(token);
    if (!userId) return problem(401, 'Authentication required.');
    c.set('userId', userId);
    await next();
  });

  const own = (userId: string) => notes.get(userId) ?? [];
  const find = (userId: string, id: string) => own(userId).find((note) => note.id === id);

  app.get('/v1/users/me', (c) => c.json({ id: c.get('userId'), email: 'x@example.com' }));

  app.get('/v1/notes', (c) => {
    const limit = Number(c.req.query('limit') ?? 20);
    const cursor = c.req.query('cursor');
    const list = own(c.get('userId'));
    const start = cursor ? list.findIndex((note) => note.id === cursor) + 1 : 0;
    const data = list.slice(start, start + limit);
    const nextCursor = start + limit < list.length ? (data.at(-1)?.id ?? null) : null;
    return c.json({ data, meta: { limit, nextCursor } });
  });

  app.post('/v1/notes', async (c) => {
    const input = (await c.req.json()) as { title: string; body: string };
    counter += 1;
    const note = {
      id: `note_${counter}`,
      ...input,
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    notes.set(c.get('userId'), [note, ...own(c.get('userId'))]);
    return c.json(note, 201);
  });

  app.get('/v1/notes/:id', (c) => {
    const note = find(c.get('userId'), c.req.param('id'));
    if (!note) return problem(404, `Note ${c.req.param('id')} does not exist.`);
    c.header('ETag', `"${note.version}"`);
    return c.json(note);
  });

  app.patch('/v1/notes/:id', async (c) => {
    const note = find(c.get('userId'), c.req.param('id'));
    if (!note) return problem(404, `Note ${c.req.param('id')} does not exist.`);
    if (c.req.header('if-match') !== `"${note.version}"`) return problem(412, 'Stale.');
    Object.assign(note, await c.req.json(), { version: note.version + 1 });
    c.header('ETag', `"${note.version}"`);
    return c.json(note);
  });

  app.delete('/v1/notes/:id', (c) => {
    const userId = c.get('userId');
    if (!find(userId, c.req.param('id'))) {
      return problem(404, `Note ${c.req.param('id')} does not exist.`);
    }
    notes.set(
      userId,
      own(userId).filter((note) => note.id !== c.req.param('id')),
    );
    return c.body(null, 204);
  });

  const api: FakeNotesApi = {
    app,
    fetch: ((input: string | URL | Request, init?: RequestInit) => {
      if (init?.signal?.aborted) return Promise.reject(init.signal.reason);
      return Promise.resolve(app.request(input instanceof URL ? input.toString() : input, init));
    }) as typeof fetch,
    notes,
    requests,
    delayMs: 0,
    failNext: (status, detail = 'Failure.', headers = {}) => {
      failure = { status, detail, headers };
    },
    addUser: (userId, token) => {
      tokens.set(token, userId);
      notes.set(userId, []);
    },
  };
  return api;
}
