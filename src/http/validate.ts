import type { Context } from 'hono';
import type { z } from 'zod';
import { ProblemError } from '../platform/problem.ts';

function problem(error: z.ZodError): ProblemError {
  return new ProblemError(
    'validation-failed',
    'The request has invalid fields. See `errors` for each one, then fix them and retry.',
    {
      errors: error.issues.map((issue) => ({
        field: issue.path.join('.') || 'body',
        detail: issue.message,
      })),
    },
  );
}

export async function jsonBody<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  if (!c.req.header('content-type')?.toLowerCase().startsWith('application/json')) {
    throw new ProblemError(
      'unsupported-media-type',
      'Send the body as JSON, with the header Content-Type: application/json.',
    );
  }
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new ProblemError(
      'validation-failed',
      'The request body is not valid JSON. Fix the syntax and retry.',
    );
  }
  const result = schema.safeParse(body);
  if (!result.success) throw problem(result.error);
  return result.data;
}

export function query<T extends z.ZodType>(c: Context, schema: T): z.infer<T> {
  const result = schema.safeParse(c.req.query());
  if (!result.success) throw problem(result.error);
  return result.data;
}
