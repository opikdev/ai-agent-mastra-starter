import { type OpenAPIHono, z } from '@hono/zod-openapi';
import { type ProblemSlug, type ProblemStatus, problemCatalog } from '../platform/problem.ts';
import type { AppEnv } from './router.ts';

const typePrefix = 'urn:problem:';

export const problemSchema = z
  .object({
    type: z.string().openapi({ example: `${typePrefix}not-found` }),
    title: z.string().openapi({ example: 'Resource not found' }),
    status: z.number().int().openapi({ example: 404 }),
    detail: z.string().openapi({ example: 'Thread thr_0190 does not exist.' }),
    instance: z.string().openapi({ example: '/v1/threads/thr_0190' }),
    errors: z
      .array(z.object({ field: z.string(), detail: z.string() }))
      .optional()
      .openapi({ description: 'Present when `type` is urn:problem:validation-failed' }),
    runId: z
      .string()
      .optional()
      .openapi({ description: 'Present when `type` is urn:problem:duplicate-request' }),
    runStatus: z.string().optional().openapi({
      description:
        'The status of the run `runId` names, when `type` is urn:problem:duplicate-request. `failed` means it may have run a tool, so send the message again with a new key',
    }),
  })
  .openapi('Problem');

const problemResponseNames: Record<ProblemStatus, string> = {
  400: 'BadRequest',
  401: 'Unauthorized',
  404: 'NotFound',
  409: 'Conflict',
  413: 'ContentTooLarge',
  415: 'UnsupportedMediaType',
  422: 'UnprocessableContent',
  429: 'TooManyRequests',
  500: 'InternalServerError',
  503: 'ServiceUnavailable',
};

function problemResponseRef(status: ProblemStatus) {
  return { $ref: `#/components/responses/${problemResponseNames[status]}` };
}

/** References to the shared problem responses, for a route to list the problems it returns. */
export function problemResponses(...slugs: ProblemSlug[]) {
  return Object.fromEntries(
    slugs.map((slug) => [
      problemCatalog[slug].status,
      problemResponseRef(problemCatalog[slug].status),
    ]),
  );
}

const headers = {
  'X-Request-Id': {
    description: 'Identifies the request. Quote it when you report a problem.',
    schema: { type: 'string', example: '0b5f7c1e-6a0f-4b8e-9d3c-2f1a7e4b9c10' },
  },
  'Cache-Control': {
    description: '`no-store` on every `/v1` response.',
    schema: { type: 'string', example: 'no-store' },
  },
  RateLimit: {
    description:
      'Sent on every `/v1` response. The quota left in each policy, `r`, and the seconds until it resets, `t`, per draft-ietf-httpapi-ratelimit-headers. On a 429, only the policy that was exceeded.',
    schema: { type: 'string', example: '"global";r=298;t=25' },
  },
  'RateLimit-Policy': {
    description:
      'Sent on every `/v1` response. Each policy that applies, with its quota, `q`, and window in seconds, `w`.',
    schema: { type: 'string', example: '"global";q=300;w=60, "agent";q=20;w=60' },
  },
  'Retry-After': {
    description: 'Seconds to wait before retrying.',
    schema: { type: 'integer', example: 25 },
  },
  Location: {
    description: 'The URL of the created resource.',
    schema: { type: 'string', example: '/v1/threads/thr_0190a7e4c1f07c3e8d21b6f4a9e05d13' },
  },
  'WWW-Authenticate': {
    description: 'The scheme to authenticate with.',
    schema: { type: 'string', example: 'Bearer' },
  },
} as const;

type HeaderName = keyof typeof headers;

export function headerRefs(...names: HeaderName[]) {
  return Object.fromEntries(names.map((name) => [name, { $ref: `#/components/headers/${name}` }]));
}

const commonHeaders = ['X-Request-Id', 'Cache-Control', 'RateLimit', 'RateLimit-Policy'] as const;
const retryStatuses = new Set<number>([429, 503]);
const methods = new Set(['get', 'head', 'options', 'post', 'put', 'patch', 'delete']);

function registerComponents(app: OpenAPIHono<AppEnv>) {
  const registry = app.openAPIRegistry;
  registry.register('Problem', problemSchema);
  registry.registerComponent('securitySchemes', 'bearerAuth', { type: 'http', scheme: 'bearer' });
  for (const [name, header] of Object.entries(headers)) {
    registry.registerComponent('headers', name, header);
  }
  const statuses = [...new Set(Object.values(problemCatalog).map(({ status }) => status))];
  for (const status of statuses) {
    const types = Object.entries(problemCatalog)
      .filter(([, problem]) => problem.status === status)
      .map(([slug]) => `\`${typePrefix}${slug}\``);
    registry.registerComponent('responses', problemResponseNames[status], {
      description: `Problem Details with \`type\` ${types.join(' or ')}`,
      headers: headerRefs(
        ...commonHeaders,
        ...(retryStatuses.has(status) ? (['Retry-After'] as const) : []),
        ...(status === 401 ? (['WWW-Authenticate'] as const) : []),
      ),
      content: {
        'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } },
      },
    });
  }
}

interface Operation {
  requestBody?: unknown;
  responses: Record<string, { $ref?: string; headers?: Record<string, unknown> }>;
}

/** Adds the problems and headers that middleware returns, so routes declare only their own. */
function addMiddlewareResponses(path: string, operation: Operation) {
  const isV1 = path.startsWith('/v1/');
  const statuses: ProblemStatus[] = [500];
  // Auth asks the notes API about each token, so any /v1 call can get its 503.
  if (isV1) statuses.push(401, 429, 503);
  if (operation.requestBody) statuses.push(413, 415);

  const responses = { ...operation.responses };
  for (const status of statuses) responses[status] ??= problemResponseRef(status);
  for (const response of Object.values(responses)) {
    if (response.$ref) continue;
    const standard = isV1 ? headerRefs(...commonHeaders) : headerRefs('X-Request-Id');
    response.headers = { ...standard, ...response.headers };
  }
  operation.responses = Object.fromEntries(
    Object.entries(responses).sort(([a], [b]) => Number(a) - Number(b)),
  );
}

export function describeApi(app: OpenAPIHono<AppEnv>, info: { title: string; version: string }) {
  registerComponents(app);
  const document = app.getOpenAPI31Document({ openapi: '3.1.0', info });
  for (const [path, item] of Object.entries(document.paths ?? {})) {
    for (const [method, operation] of Object.entries(item)) {
      if (methods.has(method)) addMiddlewareResponses(path, operation as Operation);
    }
  }
  return document;
}
