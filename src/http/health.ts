import { createRoute, z } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { ProblemError } from '../platform/problem.ts';
import type { Readiness } from '../platform/shutdown.ts';
import { problemResponses } from './openapi.ts';
import { createRouter } from './router.ts';

const statusSchema = z.object({ status: z.literal('ok') }).openapi('HealthStatus');

export function createHealthRoutes(db: Db, readiness: Readiness) {
  return createRouter()
    .openapi(
      createRoute({
        method: 'get',
        path: '/healthz',
        operationId: 'getLiveness',
        summary: 'Check that the process is running',
        tags: ['Health'],
        responses: {
          200: {
            description: 'The process is running',
            content: { 'application/json': { schema: statusSchema } },
          },
        },
      }),
      (c) => c.json({ status: 'ok' as const }, 200),
    )
    .openapi(
      createRoute({
        method: 'get',
        path: '/readyz',
        operationId: 'getReadiness',
        summary: 'Check that the agent can reach Postgres and is not shutting down',
        tags: ['Health'],
        responses: {
          200: {
            description: 'Ready for traffic',
            content: { 'application/json': { schema: statusSchema } },
          },
          ...problemResponses('service-unavailable'),
        },
      }),
      async (c) => {
        if (readiness.draining) {
          throw new ProblemError(
            'service-unavailable',
            'The agent is shutting down. Send traffic to another instance.',
          );
        }
        try {
          await db.execute(sql`select 1`);
        } catch (cause) {
          throw new ProblemError('service-unavailable', 'Postgres is unreachable. Retry shortly.', {
            headers: { 'Retry-After': '5' },
            cause,
          });
        }
        return c.json({ status: 'ok' as const }, 200);
      },
    );
}
