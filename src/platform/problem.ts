export const problemCatalog = {
  'validation-failed': { status: 400, title: 'Request validation failed' },
  unauthorized: { status: 401, title: 'Authentication required' },
  'not-found': { status: 404, title: 'Resource not found' },
  'thread-busy': { status: 409, title: 'Thread is busy' },
  'approval-pending': { status: 409, title: 'Approval pending' },
  'approval-not-pending': { status: 409, title: 'No approval pending' },
  'duplicate-request': { status: 409, title: 'Request already processed' },
  'payload-too-large': { status: 413, title: 'Payload too large' },
  'unsupported-media-type': { status: 415, title: 'Unsupported media type' },
  'idempotency-key-reused': { status: 422, title: 'Idempotency key reused' },
  'rate-limited': { status: 429, title: 'Too many requests' },
  'budget-exceeded': { status: 429, title: 'Daily token budget exceeded' },
  'too-many-runs': { status: 429, title: 'Too many runs at once' },
  'internal-error': { status: 500, title: 'Internal server error' },
  'service-unavailable': { status: 503, title: 'Service unavailable' },
} as const;

export type ProblemSlug = keyof typeof problemCatalog;
export type ProblemStatus = (typeof problemCatalog)[ProblemSlug]['status'];
export const problemSlugs = Object.keys(problemCatalog) as ProblemSlug[];

export interface FieldError {
  field: string;
  detail: string;
}

export interface Problem {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
  errors?: FieldError[];
  [extension: string]: unknown;
}

interface ProblemOptions {
  errors?: FieldError[];
  /** Extra members of the problem body, such as the `runId` a duplicate request started. */
  extensions?: Record<string, unknown>;
  headers?: Record<string, string>;
  cause?: unknown;
}

export class ProblemError extends Error {
  readonly slug: ProblemSlug;
  readonly status: ProblemStatus;
  readonly title: string;
  readonly errors: FieldError[] | undefined;
  readonly extensions: Record<string, unknown>;
  readonly headers: Record<string, string>;

  constructor(slug: ProblemSlug, detail: string, options: ProblemOptions = {}) {
    super(detail, { cause: options.cause });
    this.slug = slug;
    this.status = problemCatalog[slug].status;
    this.title = problemCatalog[slug].title;
    this.errors = options.errors;
    this.extensions = options.extensions ?? {};
    this.headers = options.headers ?? {};
  }

  toProblem(instance: string): Problem {
    return {
      ...this.extensions,
      type: `urn:problem:${this.slug}`,
      title: this.title,
      status: this.status,
      detail: this.message,
      instance,
      ...(this.errors ? { errors: this.errors } : {}),
    };
  }
}

export function problemResponse(error: ProblemError, instance: string): Response {
  return new Response(JSON.stringify(error.toProblem(instance)), {
    status: error.status,
    headers: { 'Content-Type': 'application/problem+json', ...error.headers },
  });
}
