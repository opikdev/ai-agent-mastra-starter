import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context } from 'hono';

export function clientIp(c: Context, trustProxy: boolean): string {
  if (trustProxy) {
    const lastHop = c.req.header('x-forwarded-for')?.split(',').at(-1)?.trim();
    if (lastHop) return lastHop;
  }
  return getConnInfo(c).remote.address ?? 'unknown';
}
