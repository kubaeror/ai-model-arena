import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { dump } from 'js-yaml';
import { auditSafe, requireRole } from '../../auth/rbac.js';
import type { AuthedRequest } from '../auth.js';
import {
  loadScenario,
  resolveScenarioPath,
  ScenarioConfigSchema,
  type ScenarioConfig,
} from '../../config.js';
import { findProjectRoot } from '../../paths.js';
import { isWithin } from '../../sandbox/sandbox.js';
import { walkFiles } from '../../fs/walk.js';
import { notFound } from '../helpers.js';

function scenariosDir(): string {
  return path.join(findProjectRoot(), 'configs', 'scenarios');
}

interface StarterFile {
  path: string;
  content: string;
}

/** Write inline starter files into configs/scenarios/templates/<safe-name>/. */
const MAX_STARTER_FILE_BYTES = 1 * 1024 * 1024; // 1 MB per file
const MAX_STARTER_FILES = 50;
/** starterFiles must reference a bare template dir under configs/scenarios/templates. */
const TEMPLATE_PATH_RE = /^templates\/[a-zA-Z0-9_-]+$/;

function writeStarterFiles(name: string, files: StarterFile[]): string {
  const safe = name.replace(/[^a-zA-Z0-9_-]/g, '-');
  const templateDir = path.resolve(path.join(scenariosDir(), 'templates', safe));
  fs.rmSync(templateDir, { recursive: true, force: true });
  fs.mkdirSync(templateDir, { recursive: true });

  const limited = files.slice(0, MAX_STARTER_FILES);
  for (const f of limited) {
    const relNormalized = String(f.path ?? '')
      .replace(/\\/g, '/')
      .replace(/^\/+/, '');
    if (!relNormalized) continue;

    const abs = path.resolve(templateDir, relNormalized);
    if (!isWithin(templateDir, abs)) continue;

    const content = String(f.content ?? '');
    if (Buffer.byteLength(content) > MAX_STARTER_FILE_BYTES) continue;

    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return `templates/${safe}`;
}

function listStarterFiles(scenario: ScenarioConfig): StarterFile[] {
  if (!scenario.starterFiles || !TEMPLATE_PATH_RE.test(scenario.starterFiles)) return [];
  const dir = path.join(scenariosDir(), scenario.starterFiles);
  // Defense in depth: YAML written before write-time validation (or by any
  // other writer) may carry a traversal starterFiles. Never walk outside
  // scenariosDir().
  if (!isWithin(scenariosDir(), dir)) return [];
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
  return walkFiles(dir).map((full) => ({
    path: path.relative(dir, full).replace(/\\/g, '/'),
    content: fs.readFileSync(full, 'utf8'),
  }));
}

function writeScenarioYaml(filePath: string, config: ScenarioConfig): ScenarioConfig {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, dump(config, { lineWidth: 120 }));
  return config;
}

export function createScenariosRouter(): Router {
  const router = Router();

  function resolveAndValidate(name: string): string | null {
    // Allow only simple alphanumeric names — no path separators or shell chars.
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) return null;
    const resolved = resolveScenarioPath(scenariosDir(), name);
    // Defence in depth: confirm resolved path is within scenariosDir.
    if (!isWithin(scenariosDir(), resolved)) return null;
    return resolved;
  }

  // GET /api/scenarios — list all
  router.get('/', (_req, res) => {
    const dir = scenariosDir();
    const files = fs.existsSync(dir)
      ? fs.readdirSync(dir).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml')).sort()
      : [];
    const scenarios: ScenarioConfig[] = [];
    for (const f of files) {
      try {
        scenarios.push(loadScenario(path.join(dir, f)));
      } catch {
        /* skip invalid scenario files */
      }
    }
    res.json({ scenarios });
  });

  // GET /api/scenarios/:name — one scenario + its starter files
  router.get('/:name', (req, res) => {
    const p = resolveAndValidate(req.params.name as string);
    if (!p) { res.status(400).json({ error: 'Invalid scenario name' }); return; }
    if (!fs.existsSync(p)) {
      notFound(res, 'Scenario', req.params.name as string);
      return;
    }
    const scenario = loadScenario(p);
    res.json({ scenario, starterFiles: listStarterFiles(scenario) });
  });

  // POST /api/scenarios — create
  router.post('/', requireRole('editor'), (req, res) => {
    const body = req.body ?? {};
    // Permissive shell policy requires admin role
    if (body.shellPolicy === 'permissive' && (req as AuthedRequest).user?.role !== 'admin') {
      res.status(403).json({ error: 'Permissive shell policy requires admin approval' });
      return;
    }
    let starterFiles = body.starterFiles;
    if (Array.isArray(body.starterFilesContent) && body.starterFilesContent.length) {
      const name = String(body.name ?? '');
      starterFiles = writeStarterFiles(name, body.starterFilesContent);
    }
    const parsed = ScenarioConfigSchema.parse({ ...body, starterFiles });
    if (parsed.starterFiles !== undefined && !TEMPLATE_PATH_RE.test(parsed.starterFiles)) {
      res.status(400).json({ error: 'Invalid starterFiles; must be templates/<bare-name>' });
      return;
    }
    // Validate the scenario name BEFORE resolving the path. The body `name`
    // was previously passed straight to resolveScenarioPath(), which accepted
    // absolute paths and `../` traversal — allowing an editor to write a YAML
    // file to arbitrary filesystem locations (e.g. overwrite configs/api-keys.yaml
    // to register an admin API key). resolveAndValidate() enforces a bare
    // alphanumeric name and isWithin(scenariosDir()) on the resolved path.
    const p = resolveAndValidate(parsed.name);
    if (!p) {
      res.status(400).json({ error: 'Invalid scenario name; must be alphanumeric with - or _ only' });
      return;
    }
    if (fs.existsSync(p)) {
      res.status(409).json({ error: 'Scenario already exists; use PUT to edit' });
      return;
    }
    writeScenarioYaml(p, parsed);
    res.status(201).json({ scenario: parsed });
  });

  // PUT /api/scenarios/:name — edit (optionally rename)
  router.put('/:name', requireRole('editor'), (req, res) => {
    // Permissive shell policy requires admin role
    if (req.body?.shellPolicy === 'permissive' && (req as AuthedRequest).user?.role !== 'admin') {
      res.status(403).json({ error: 'Permissive shell policy requires admin approval' });
      return;
    }
    const p = resolveAndValidate(req.params.name as string);
    if (!p) { res.status(400).json({ error: 'Invalid scenario name' }); return; }
    if (!fs.existsSync(p)) {
      notFound(res, 'Scenario', req.params.name as string);
      return;
    }
    const existing = loadScenario(p);
    const body = req.body ?? {};
    const newName = String(body.name ?? existing.name);
    // Validate the rename target the same way as POST: bare alphanumeric name,
    // resolved path must stay within scenariosDir(). Without this, a PUT with
    // body.name = "/etc/cron.d/evil.yaml" could write outside scenariosDir().
    const target = newName !== existing.name ? resolveAndValidate(newName) : p;
    if (!target) {
      res.status(400).json({ error: 'Invalid scenario name; must be alphanumeric with - or _ only' });
      return;
    }

    let starterFiles = body.starterFiles ?? existing.starterFiles;
    if (Array.isArray(body.starterFilesContent) && body.starterFilesContent.length) {
      starterFiles = writeStarterFiles(newName, body.starterFilesContent);
    }
    const parsed = ScenarioConfigSchema.parse({ ...existing, ...body, name: newName, starterFiles });
    if (parsed.starterFiles !== undefined && !TEMPLATE_PATH_RE.test(parsed.starterFiles)) {
      res.status(400).json({ error: 'Invalid starterFiles; must be templates/<bare-name>' });
      return;
    }
    writeScenarioYaml(target, parsed);
    if (target !== p && fs.existsSync(p)) fs.unlinkSync(p);
    auditSafe((req as AuthedRequest).user?.sub ?? 'system', 'scenario.update', { type: 'scenario', id: newName });
    res.json({ scenario: parsed });
  });

  // DELETE /api/scenarios/:name
  router.delete('/:name', requireRole('editor'), (req, res) => {
    const p = resolveAndValidate(req.params.name as string);
    if (!p) { res.status(400).json({ error: 'Invalid scenario name' }); return; }
    if (!fs.existsSync(p)) {
      notFound(res, 'Scenario', req.params.name as string);
      return;
    }
    const scenario = loadScenario(p);
    fs.unlinkSync(p);
    if (scenario.starterFiles && TEMPLATE_PATH_RE.test(scenario.starterFiles)) {
      const tplDir = path.join(scenariosDir(), scenario.starterFiles);
      // Never rm -rf outside scenariosDir() (see listStarterFiles note).
      if (isWithin(scenariosDir(), tplDir)) {
        fs.rmSync(tplDir, { recursive: true, force: true });
      }
    }
    auditSafe((req as AuthedRequest).user?.sub ?? 'system', 'scenario.delete', { type: 'scenario', id: req.params.name as string });
    res.json({ deleted: req.params.name as string });
  });

  return router;
}
