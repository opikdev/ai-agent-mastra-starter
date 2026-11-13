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

function ipv6Groups(address: string): number[] {
  let text = address.split('%')[0] as string;
  const embedded = /(\d+\.\d+\.\d+\.\d+)$/.exec(text)?.[1];
  if (embedded) {
    const [a, b, c, d] = embedded.split('.').map(Number) as [number, number, number, number];
    text = `${text.slice(0, -embedded.length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = '', tail] = text.split('::');
  const parse = (part: string) =>
    part ? part.split(':').map((group) => Number.parseInt(group, 16)) : [];
  const left = parse(head);
  const right = tail === undefined ? [] : parse(tail);
  return [...left, ...Array(8 - left.length - right.length).fill(0), ...right];
}

/**
 * The network a client is counted as: an IPv4 address whole, an IPv4-mapped IPv6 address as its
 * IPv4 address, and any other IPv6 address as its /64, which one subscriber usually controls.
 */
export function clientNetwork(address: string): string {
  if (isIP(address) !== 6) return address;
  const groups = ipv6Groups(address);
  const isMapped = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
  if (isMapped) {
    const [high = 0, low = 0] = groups.slice(6);
    return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
  }
  const prefix = [...groups.slice(0, 4), 0, 0, 0, 0].map((group) => group.toString(16)).join(':');
  return `${new URL(`http://[${prefix}]`).hostname.slice(1, -1)}/64`;
}
