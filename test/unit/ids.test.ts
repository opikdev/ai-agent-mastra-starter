import { describe, expect, it } from 'vitest';
import { fromPublicId, newThreadId, toPublicId } from '../../src/http/ids.ts';

describe('public IDs', () => {
  it('round-trips a UUID', () => {
    const uuid = '0190a7e4-c1d2-7c3e-9b8f-6a5d4c3b2a10';
    expect(fromPublicId('run', toPublicId('run', uuid))).toBe(uuid);
  });

  it.each(['thr_0190a7e4c1d27c3e9b8f6a5d4c3b2a10', 'run_xyz', 'run_', ''])(
    'rejects %s as a run ID',
    (id) => {
      expect(fromPublicId('run', id)).toBeNull();
    },
  );

  it('makes unique thread IDs', () => {
    const ids = new Set(Array.from({ length: 100 }, newThreadId));
    expect(ids.size).toBe(100);
    for (const id of ids) expect(id).toMatch(/^thr_[0-9a-f]{32}$/);
  });
});
