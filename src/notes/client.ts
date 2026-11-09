import { z } from 'zod';

const noteSchema = z.object({
  id: z.string(),
  title: z.string(),
  body: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const pageSchema = z.object({
  data: z.array(noteSchema),
  meta: z.object({ nextCursor: z.string().nullable() }),
});

const userSchema = z.object({ id: z.string() });

const problemSchema = z.object({ detail: z.string().optional() });

export type Note = z.infer<typeof noteSchema>;
export type NotePage = z.infer<typeof pageSchema>;
export type NoteChanges = { title?: string | undefined; body?: string | undefined };

/** A failure the model can read and act on. Messages never include credentials or raw bodies. */
export class UpstreamError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.status = status;
  }
}

export interface NotesClient {
  me(): Promise<{ id: string }>;
  list(options: { limit: number; cursor?: string | undefined }): Promise<NotePage>;
  get(id: string): Promise<Note>;
  create(input: { title: string; body: string }): Promise<Note>;
  update(id: string, changes: NoteChanges): Promise<Note>;
  remove(id: string): Promise<void>;
}

export interface NotesClientOptions {
  baseUrl: string;
  token: string;
  timeoutMs: number;
  fetch?: typeof fetch;
}

async function problemDetail(response: Response): Promise<string | undefined> {
  try {
    return problemSchema.parse(await response.json()).detail;
  } catch {
    return undefined;
  }
}

async function toError(response: Response): Promise<UpstreamError> {
  const detail = await problemDetail(response);
  switch (response.status) {
    case 401:
      return new UpstreamError('The notes API rejected the credentials.', 401);
    case 404:
      return new UpstreamError(detail ?? 'That note does not exist.', 404);
    case 412:
      return new UpstreamError('The note changed while updating it. Fetch it again first.', 412);
    case 429: {
      const retryAfter = Number(response.headers.get('retry-after')) || 60;
      return new UpstreamError(
        `The notes API is rate limiting requests. Retry in ${retryAfter} seconds.`,
        429,
      );
    }
    default:
      if (response.status >= 400 && response.status < 500) {
        return new UpstreamError(
          `The notes API refused the request: ${detail ?? `HTTP ${response.status}`}`,
          response.status,
        );
      }
      return new UpstreamError(
        `The notes API failed with HTTP ${response.status}. Try again later.`,
        response.status,
      );
  }
}

export function createNotesClient({
  baseUrl,
  token,
  timeoutMs,
  fetch: fetcher = fetch,
}: NotesClientOptions): NotesClient {
  const root = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;

  async function send(path: string, init: RequestInit = {}): Promise<Response> {
    let response: Response;
    try {
      response = await fetcher(new URL(path, root), {
        ...init,
        headers: { Accept: 'application/json', Authorization: `Bearer ${token}`, ...init.headers },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'TimeoutError') {
        throw new UpstreamError(
          `The notes API didn't answer within ${timeoutMs / 1000} seconds. Try again later.`,
        );
      }
      throw new UpstreamError("Couldn't reach the notes API. Try again later.");
    }
    if (!response.ok) throw await toError(response);
    return response;
  }

  async function parse<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
    const parsed = schema.safeParse(await response.json().catch(() => undefined));
    if (!parsed.success) {
      throw new UpstreamError("The notes API sent a response this agent doesn't understand.");
    }
    return parsed.data;
  }

  const notePath = (id: string) => `v1/notes/${encodeURIComponent(id)}`;
  const json = { 'Content-Type': 'application/json' };

  return {
    async me() {
      return parse(await send('v1/users/me'), userSchema);
    },
    async list({ limit, cursor }) {
      const query = new URLSearchParams({ limit: String(limit) });
      if (cursor) query.set('cursor', cursor);
      return parse(await send(`v1/notes?${query}`), pageSchema);
    },
    async get(id) {
      return parse(await send(notePath(id)), noteSchema);
    },
    async create(input) {
      const response = await send('v1/notes', {
        method: 'POST',
        headers: json,
        body: JSON.stringify(input),
      });
      return parse(response, noteSchema);
    },
    async update(id, changes) {
      const current = await send(notePath(id));
      const etag = current.headers.get('etag');
      await current.body?.cancel();
      if (!etag) throw new UpstreamError('The notes API sent a note without an ETag.');
      const response = await send(notePath(id), {
        method: 'PATCH',
        headers: { ...json, 'If-Match': etag },
        body: JSON.stringify(changes),
      });
      return parse(response, noteSchema);
    },
    async remove(id) {
      await send(notePath(id), { method: 'DELETE' });
    },
  };
}
