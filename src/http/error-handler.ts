import type { Context, ErrorHandler } from 'hono';
import type { AppEnv } from './env.ts';
import type { Logger } from './logger.ts';
import { ProblemError, problemResponse } from './problem.ts';

export function internalError(requestId: string): ProblemError {
  return new ProblemError(
    'internal-error',
    `Something went wrong on our side. Retry, and quote request ${requestId} if it persists.`,
  );
}

/** Builds the response from scratch, so it copies the request ID the middleware already set. */
export function respond(c: Context<AppEnv>, error: ProblemError): Response {
  const response = problemResponse(error, c.req.path);
  response.headers.set('X-Request-Id', c.get('requestId'));
  return response;
}

export function createErrorHandler(logger: Logger): ErrorHandler<AppEnv> {
  return (error, c) => {
    if (error instanceof ProblemError) {
      if (error.cause) {
        logger.warn({ err: error.cause, requestId: c.get('requestId') }, error.message);
      }
      return respond(c, error);
    }
    logger.error({ err: error, requestId: c.get('requestId') }, 'Unhandled error');
    return respond(c, internalError(c.get('requestId')));
  };
}
