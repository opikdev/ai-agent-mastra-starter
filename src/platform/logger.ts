import { type DestinationStream, pino } from 'pino';

export const logRedactions = [
  'authorization',
  'password',
  'token',
  '*.authorization',
  '*.password',
  '*.token',
];

export function createLogger(level: string, destination?: DestinationStream) {
  return pino({ level, redact: logRedactions }, destination);
}

export type Logger = ReturnType<typeof createLogger>;
