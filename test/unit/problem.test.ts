import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { problemSlugs } from '../../src/platform/problem.ts';

function documentedSlugs(): string[] {
  const doc = readFileSync('docs/errors.md', 'utf8');
  return [...doc.matchAll(/^\| `([a-z-]+)` \| \d{3} \|/gm)].map((match) => match[1] as string);
}

describe('problem types', () => {
  it('documents exactly the slugs the API can return', () => {
    expect(documentedSlugs().sort()).toEqual([...problemSlugs].sort());
  });
});
