import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { json, startStack, type TestStack } from '../helpers.ts';

interface Response {
  $ref?: string;
  headers?: Record<string, unknown>;
  content?: Record<string, unknown>;
}

interface Operation {
  operationId?: string;
  summary?: string;
  security?: unknown[];
  requestBody?: unknown;
  responses: Record<string, Response>;
}

interface Document {
  openapi: string;
  info: { title: string; version: string };
  paths: Record<string, Record<string, Operation>>;
  components: { responses: Record<string, Response> };
}

let stack: TestStack;
beforeAll(async () => {
  stack = await startStack({ DOCS_ENABLED: 'true' });
});
afterAll(() => stack.close());

async function spec(): Promise<Document> {
  return json(await stack.app.request('/openapi.json'));
}

function operationsOf(document: Document) {
  return Object.entries(document.paths).flatMap(([path, methods]) =>
    Object.entries(methods).map(([method, operation]) => ({ path, method, operation })),
  );
}

function resolve(document: Document, response: Response): Response {
  const name = response.$ref?.replace('#/components/responses/', '');
  return name ? (document.components.responses[name] as Response) : response;
}

describe('the OpenAPI document', () => {
  it('is OpenAPI 3.1, titled with the project name and version', async () => {
    const document = await spec();
    const { name, version } = JSON.parse(readFileSync('package.json', 'utf8'));
    expect(document.openapi).toMatch(/^3\.1/);
    expect(document.info).toEqual({ title: name, version });
  });

  it('matches the committed openapi.json', async () => {
    expect(await spec()).toEqual(JSON.parse(readFileSync('openapi.json', 'utf8')));
  });

  it('documents every operation, its auth, and every status the middleware can return', async () => {
    const document = await spec();
    const operations = operationsOf(document);
    expect(operations.length).toBe(9);
    for (const { path, method, operation } of operations) {
      const label = `${method.toUpperCase()} ${path}`;
      expect(operation.operationId, label).toBeTruthy();
      expect(operation.summary, label).toBeTruthy();
      const expected = ['500'];
      if (path.startsWith('/v1/')) {
        expect(operation.security, label).toEqual([{ bearerAuth: [] }]);
        expected.push('401', '429', '503');
      }
      if (operation.requestBody) expected.push('413', '415');
      expect(Object.keys(operation.responses), label).toEqual(expect.arrayContaining(expected));

      for (const [status, reference] of Object.entries(operation.responses)) {
        const response = resolve(document, reference);
        const headers = Object.keys(response.headers ?? {});
        expect(headers, `${label} ${status}`).toContain('X-Request-Id');
        if (path.startsWith('/v1/')) {
          expect(headers, `${label} ${status}`).toEqual(
            expect.arrayContaining(['RateLimit', 'RateLimit-Policy', 'Cache-Control']),
          );
        }
        if (Number(status) >= 400) {
          expect(response.content, `${label} ${status}`).toHaveProperty([
            'application/problem+json',
          ]);
        }
        if (status === '429') expect(headers, label).toContain('Retry-After');
      }
    }
  });

  it('documents the event stream and the Idempotency-Key of sendMessage', async () => {
    const operation = (await spec()).paths['/v1/threads/{id}/messages']?.post;
    expect(operation?.responses['200']?.content).toHaveProperty(['text/event-stream']);
    expect(JSON.stringify(operation)).toContain('idempotency-key');
    expect(operation?.responses['422']?.$ref).toBe('#/components/responses/UnprocessableContent');
  });
});

describe('the docs page', () => {
  it('serves its own assets under a strict policy, with no third-party origin', async () => {
    const response = await stack.app.request('/docs');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-security-policy')).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
    const page = await response.text();
    expect(page).toContain('<title>ai-agent-mastra-starter</title>');
    expect(page).not.toMatch(/https?:\/\//);
    expect([...page.matchAll(/<script(?![^>]*\ssrc=)[^>]*>|<style\b/gi)]).toEqual([]);
    for (const src of page.matchAll(/(?:src|href)="([^"]+)"/g)) {
      const asset = await stack.app.request(src[1] as string);
      expect(asset.status, src[1]).toBe(200);
      expect(asset.headers.get('content-security-policy'), src[1]).toContain("script-src 'self'");
    }
  });

  it.each(['/docs', '/docs/init.js', '/openapi.json'])(
    'returns 404 for %s when docs are off, as they are by default',
    async (path) => {
      const off = await startStack();
      try {
        const response = await off.app.request(path);
        expect(response.status).toBe(404);
        expect((await json(response)).type).toBe('urn:problem:not-found');
      } finally {
        await off.close();
      }
    },
  );
});
