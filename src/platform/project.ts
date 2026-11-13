import { readFileSync } from 'node:fs';

/** The name and version in package.json, so a renamed project reports its own identity. */
export const project = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { name: string; version: string };
