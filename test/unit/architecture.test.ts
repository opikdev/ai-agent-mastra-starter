import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sourceRoot = resolve('src');
const entryPoints = ['index.ts', 'app.ts', 'instrumentation.ts', 'db/migrate.ts'];

const allowedAreas: Record<string, string[]> = {
  'config.ts': [],
  platform: ['db'],
  db: [],
  notes: ['platform'],
  agent: ['config.ts', 'db', 'notes', 'platform'],
  http: ['agent', 'config.ts', 'db', 'notes', 'platform'],
};

function sourceFiles(): string[] {
  return readdirSync(sourceRoot, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.ts'))
    .map((file) => relative(sourceRoot, join(sourceRoot, file)));
}

function localImports(file: string): string[] {
  const source = readFileSync(join(sourceRoot, file), 'utf8');
  return [...source.matchAll(/(?:from|import) '(\.[^']+)'/g)].map((match) =>
    relative(sourceRoot, resolve(dirname(join(sourceRoot, file)), match[1] as string)),
  );
}

function area(file: string): string {
  return file.split('/')[0] as string;
}

describe('architecture', () => {
  it('knows every area of src/', () => {
    const areas = new Set(
      sourceFiles()
        .filter((file) => !entryPoints.includes(file))
        .map(area),
    );
    expect([...areas].sort()).toEqual(Object.keys(allowedAreas).sort());
  });

  it('keeps imports pointing from HTTP to the agent to the platform', () => {
    const violations = sourceFiles()
      .filter((file) => !entryPoints.includes(file))
      .flatMap((file) =>
        localImports(file)
          .filter((target) => area(target) !== area(file))
          .filter((target) => !allowedAreas[area(file)]?.includes(area(target)))
          .map((target) => `${file} -> ${target}`),
      );
    expect(violations).toEqual([]);
  });

  it('keeps Hono out of everything but the HTTP layer', () => {
    const outside = sourceFiles()
      .filter((file) => !entryPoints.includes(file) && area(file) !== 'http')
      .filter((file) => /from 'hono[/']/.test(readFileSync(join(sourceRoot, file), 'utf8')));
    expect(outside).toEqual([]);
  });
});
