import { describe, expect, it } from 'vitest';
import { createPool } from '../../src/db/client.ts';

describe('createPool', () => {
  it('opens at most the configured number of connections', async () => {
    const pool = createPool('postgres://u:p@localhost/db', 5000, 3);
    expect(pool.options.max).toBe(3);
    await pool.end();
  });
});
