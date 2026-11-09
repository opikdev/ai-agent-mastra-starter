import { isIP } from 'node:net';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context } from 'hono';

function forwardedIp(c: Context, trustedHops: number): string | undefined {
  const addresses = c.req.header('x-forwarded-for')?.split(',') ?? [];
  if (addresses.length === 0) return undefined;
  const address = addresses.at(-Math.min(trustedHops, addresses.length))?.trim();
  return address && isIP(address) ? address : undefined;
}

export function clientIp(c: Context, trustedHops: number): string {
  const forwarded = trustedHops > 0 ? forwardedIp(c, trustedHops) : undefined;
  return forwarded ?? getConnInfo(c).remote.address ?? 'unknown';
}
