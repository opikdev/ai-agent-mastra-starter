import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Hono } from 'hono';
import { html } from 'hono/html';
import type { AppEnv } from './router.ts';

const contentSecurityPolicy = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

const swaggerUiDirectory = dirname(
  createRequire(import.meta.url).resolve('swagger-ui-dist/package.json'),
);

const assets = [
  {
    path: '/docs/swagger-ui.css',
    file: join(swaggerUiDirectory, 'swagger-ui.css'),
    type: 'text/css',
  },
  {
    path: '/docs/swagger-ui-bundle.js',
    file: join(swaggerUiDirectory, 'swagger-ui-bundle.js'),
    type: 'text/javascript',
  },
  {
    path: '/docs/init.js',
    file: fileURLToPath(new URL('./docs/init.js', import.meta.url)),
    type: 'text/javascript',
  },
];

/** Serves Swagger UI from the pinned swagger-ui-dist package, with no third-party origins. */
export function mountApiDocs(app: Hono<AppEnv>, title: string) {
  const page = html`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <link rel="stylesheet" href="/docs/swagger-ui.css" />
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="/docs/swagger-ui-bundle.js"></script>
    <script src="/docs/init.js"></script>
  </body>
</html>`;

  app.get('/docs', (c) => {
    c.header('Content-Security-Policy', contentSecurityPolicy);
    return c.html(page);
  });
  for (const asset of assets) {
    const body = readFileSync(asset.file);
    app.get(asset.path, (c) => {
      c.header('Content-Security-Policy', contentSecurityPolicy);
      return c.body(body, 200, { 'Content-Type': `${asset.type}; charset=utf-8` });
    });
  }
}
