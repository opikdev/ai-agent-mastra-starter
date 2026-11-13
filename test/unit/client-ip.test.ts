import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { clientIp, clientNetwork } from '../../src/http/client-ip.ts';

const socketAddress = '198.51.100.7';

async function ipFor(trustedHops: number, forwardedFor?: string | string[]) {
  const app = new Hono().get('/', (c) => c.text(clientIp(c, trustedHops)));
  const headers = new Headers();
  for (const value of [forwardedFor ?? []].flat()) headers.append('X-Forwarded-For', value);
  const env = { incoming: { socket: { remoteAddress: socketAddress } } };
  const response = await app.request('/', { headers }, env);
  return response.text();
}

describe('clientIp', () => {
  it('ignores a spoofed X-Forwarded-For with 0 hops', async () => {
    expect(await ipFor(0, '203.0.113.1')).toBe(socketAddress);
  });

  it('uses the socket address without X-Forwarded-For', async () => {
    expect(await ipFor(1)).toBe(socketAddress);
  });

  it.each([
    [1, '203.0.113.9, 192.0.2.1, 192.0.2.2', '192.0.2.2'],
    [2, '203.0.113.9, 192.0.2.1, 192.0.2.2', '192.0.2.1'],
    [3, '203.0.113.9, 192.0.2.1, 192.0.2.2', '203.0.113.9'],
    [2, ['203.0.113.9', '192.0.2.1, 192.0.2.2'], '192.0.2.1'],
    [1, '2001:db8::1', '2001:db8::1'],
  ])('takes entry %i from the right of %j', async (hops, header, expected) => {
    expect(await ipFor(hops, header)).toBe(expected);
  });

  it('takes the leftmost entry when there are fewer entries than hops', async () => {
    expect(await ipFor(3, '203.0.113.9, 192.0.2.1')).toBe('203.0.113.9');
  });

  it.each(['', '192.0.2.1, ', 'unknown', '192.0.2.1, not-an-ip'])(
    'falls back to the socket address for %j',
    async (header) => {
      expect(await ipFor(1, header)).toBe(socketAddress);
    },
  );
});

describe('clientNetwork', () => {
  it.each([
    ['198.51.100.7', '198.51.100.7'],
    ['::ffff:198.51.100.7', '198.51.100.7'],
    ['::ffff:c633:6407', '198.51.100.7'],
    ['2001:db8:1:2:3:4:5:6', '2001:db8:1:2::/64'],
    ['2001:0db8:0001:0002:ffff:ffff:ffff:ffff', '2001:db8:1:2::/64'],
    ['2001:db8::1', '2001:db8::/64'],
    ['2001:db8:0:0:1::', '2001:db8::/64'],
    ['::1', '::/64'],
    ['fe80::1%eth0', 'fe80::/64'],
    ['64:ff9b::198.51.100.7', '64:ff9b::/64'],
    ['unknown', 'unknown'],
  ])('counts %s as %s', (address, network) => {
    expect(clientNetwork(address)).toBe(network);
  });
});
