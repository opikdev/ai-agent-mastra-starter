import { ProblemError } from '../platform/problem.ts';
import type { Assistant } from './mastra.ts';
import type { Runs } from './runs.ts';

const pageSize = 100;
const maxPages = 10;

/**
 * Deletes threads, with their messages, that nobody has used in `days` days. A thread that's
 * answering a message is left for the next pass. Deletes at most 1,000 per call, oldest first.
 */
export async function deleteInactiveThreads(
  agent: Assistant,
  runs: Runs,
  days: number,
  now = new Date(),
): Promise<number> {
  const memory = await agent.getMemory();
  if (!memory) return 0;
  const cutoff = now.getTime() - days * 24 * 60 * 60 * 1000;
  const skipped = new Set<string>();
  let deleted = 0;

  for (let page = 0; page < maxPages; page += 1) {
    const { threads } = await memory.listThreads({
      page: 0,
      perPage: pageSize,
      orderBy: { field: 'updatedAt', direction: 'ASC' },
    });
    const expired = threads.filter(
      (thread) => thread.updatedAt.getTime() < cutoff && !skipped.has(thread.id),
    );
    if (expired.length === 0) break;
    for (const thread of expired) {
      try {
        await runs.closeThread(thread.id);
      } catch (error) {
        if (!(error instanceof ProblemError)) throw error;
        skipped.add(thread.id);
        continue;
      }
      await memory.deleteThread(thread.id);
      deleted += 1;
    }
  }
  return deleted;
}
