import { OpenAPIHono } from '@hono/zod-openapi';
import type { ZodError } from 'zod';
import type { AgentContext } from '../agent/context.ts';
import { ProblemError } from '../platform/problem.ts';
import type { PolicyState } from './rate-limit.ts';

export interface AppEnv {
  Variables: {
    requestId: string;
    user: AgentContext;
    rateLimits: PolicyState[] | undefined;
  };
}

function toValidationProblem(error: ZodError): ProblemError {
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

/** A Hono app that describes its routes in OpenAPI and answers invalid input with a problem. */
export function createRouter() {
  return new OpenAPIHono<AppEnv>({
    defaultHook: (result) => {
      if (!result.success) throw toValidationProblem(result.error);
    },
  });
}
