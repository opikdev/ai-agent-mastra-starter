import { setTimeout as sleep } from 'node:timers/promises';

type Task = () => Promise<void>;

const finalTasks: Task[] = [];

/** Registers a task, such as flushing telemetry, to run after the server and database close. */
export function onShutdown(task: Task): void {
  finalTasks.push(task);
}

export interface Readiness {
  draining: boolean;
}

interface Server {
  close(callback: (error?: Error) => void): unknown;
  closeAllConnections?: () => void;
}

interface ShutdownOptions {
  server: Server;
  readiness: Readiness;
  drainMs: number;
  timeoutMs: number;
  /** Ends what's still running at the timeout, such as agent runs. */
  abortInFlight: () => void;
  /** How long aborted requests get to send their last events before connections close. */
  settleMs: number;
  /** Closes Mastra, the pool, and anything else that must close after the server. */
  close: () => Promise<void>;
}

/**
 * Fails readiness and keeps serving for `drainMs`, so load balancers stop sending traffic. Then
 * stops accepting connections and gives requests in flight, such as streaming runs, `timeoutMs`
 * to finish. At the timeout it aborts them, gives them `settleMs` to save and report it, then
 * closes every connection and everything else.
 */
export async function shutdown({
  server,
  readiness,
  drainMs,
  timeoutMs,
  abortInFlight,
  settleMs,
  close,
}: ShutdownOptions): Promise<void> {
  readiness.draining = true;
  await sleep(drainMs);
  await new Promise<void>((resolve, reject) => {
    const abort = setTimeout(abortInFlight, timeoutMs);
    const forceClose = setTimeout(() => server.closeAllConnections?.(), timeoutMs + settleMs);
    server.close((error) => {
      clearTimeout(abort);
      clearTimeout(forceClose);
      if (error) reject(error);
      else resolve();
    });
  });
  await close();
  for (const task of finalTasks) await task();
}
