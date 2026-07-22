import type { Express } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { load } from 'js-yaml';
import { findProjectRoot } from '../paths.js';
import { createLogger } from '../logger/pino-logger.js';

const logger = createLogger('ai-arena:openapi');

function specPath(): string {
  return path.join(findProjectRoot(), 'openapi.yaml');
}

/** Read + parse the OpenAPI spec once (cached). */
let cachedYaml: string | null = null;
let cachedJson: unknown = null;

function loadSpec(): { yaml: string; json: unknown } | null {
  if (cachedYaml && cachedJson) return { yaml: cachedYaml, json: cachedJson };
  const p = specPath();
  if (!fs.existsSync(p)) {
    logger.warn('openapi.yaml not found', { path: p });
    return null;
  }
  cachedYaml = fs.readFileSync(p, 'utf8');
  cachedJson = load(cachedYaml);
  return { yaml: cachedYaml, json: cachedJson };
}

/**
 * Mount the OpenAPI spec under `/api/docs` (and `/api/v1/docs`):
 *   GET /api/docs         — Swagger UI HTML (renders the spec inline)
 *   GET /api/docs/openapi.yaml — raw YAML
 *   GET /api/docs/openapi.json — JSON
 */
export function mountOpenApi(app: Express): void {
  app.get('/api/docs', (_req, res) => {
    const spec = loadSpec();
    if (!spec) { res.status(404).type('text/plain').send('openapi.yaml not found'); return; }
    const html = swaggerUiHtml(spec.json as Record<string, unknown>);
    res.setHeader('Content-Security-Policy', "script-src 'self' https://unpkg.com; style-src 'self' 'unsafe-inline' https://unpkg.com; default-src 'self'");
    res.type('text/html').send(html);
  });

  app.get('/api/docs/openapi.yaml', (_req, res) => {
    const spec = loadSpec();
    if (!spec) { res.status(404).send('not found'); return; }
    res.type('text/yaml').send(spec.yaml);
  });

  app.get('/api/docs/openapi.json', (_req, res) => {
    const spec = loadSpec();
    if (!spec) { res.status(404).send('not found'); return; }
    res.json(spec.json);
  });

  app.get('/api/v1/docs', (_req, res) => res.redirect(302, '/api/docs'));
}

function swaggerUiHtml(spec: Record<string, unknown>): string {
  const SWAGGER_VERSION = '5.20.5';
  const base = `https://unpkg.com/swagger-ui-dist@${SWAGGER_VERSION}`;
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8"/>
  <title>ai-model-arena API</title>
  <link rel="stylesheet" href="${base}/swagger-ui.css"/>
  <style>body{margin:0}</style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="${base}/swagger-ui-bundle.js"></script>
  <script>
    window.onload = () => {
      window.ui = SwaggerUIBundle({
        spec: ${JSON.stringify(spec)},
        dom_id: '#swagger-ui',
        deepLinking: true,
      });
    };
  </script>
</body>
</html>`;
}
