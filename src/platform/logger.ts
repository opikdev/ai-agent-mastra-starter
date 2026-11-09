import { type DestinationStream, pino } from 'pino';

export const logRedactions = [
  'authorization',
  'password',
  'token',
  '*.authorization',
  '*.password',
  '*.token',
];

const errorFields = ['code', 'statusCode', 'url', 'isRetryable'];

/**
 * Logs what went wrong, never the data an error carries. AI SDK errors hold the whole prompt in
 * `requestBodyValues`, and pino's default serializer would log it.
 */
export function serializeError(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { message: String(error) };
  const fields = errorFields
    .filter((field) => field in error)
    .map((field) => [field, (error as unknown as Record<string, unknown>)[field]]);
  return {
    type: error.name,
    message: error.message,
    stack: error.stack,
    ...Object.fromEntries(fields),
    ...(error.cause === undefined ? {} : { cause: serializeError(error.cause) }),
  };
}

/** Shared by the app's logger and Mastra's, which logs errors under `error`. */
export const logSerializers = { err: serializeError, error: serializeError };

export function createLogger(level: string, destination?: DestinationStream) {
  return pino({ level, redact: logRedactions, serializers: logSerializers }, destination);
}

export type Logger = ReturnType<typeof createLogger>;
