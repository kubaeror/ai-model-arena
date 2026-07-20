import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import {
  loadScenario,
  resolveScenarioPath,
  ScenarioConfigSchema,
  type ScenarioConfig,
} from '../../config.js';
import { findProjectRoot } from '../../paths.js';
import { isWithin } from '../../sandbox/sandbox.js';

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
  if (!scenario.starterFiles) return [];
  const dir = path.join(scenariosDir(), scenario.starterFiles);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
  const out: StarterFile[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) {
        out.push({ path: path.relative(dir, full).replace(/\\/g, '/'), content: fs.readFileSync(full, 'utf8') });
      }
    }
  };
  walk(dir);
  return out;
}

function writeScenarioYaml(filePath: string, config: ScenarioConfig): ScenarioConfig {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, yaml.dump(config, { lineWidth: 120 }));
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
    const p = resolveAndValidate(req.params.name);
    if (!p) { res.status(400).json({ error: 'Invalid scenario name' }); return; }
    if (!fs.existsSync(p)) {
      res.status(404).json({ error: 'Scenario not found' });
      return;
    }
    const scenario = loadScenario(p);
    res.json({ scenario, starterFiles: listStarterFiles(scenario) });
  });

  // POST /api/scenarios — create
  router.post('/', (req, res) => {
    const body = req.body ?? {};
    let starterFiles = body.starterFiles;
    if (Array.isArray(body.starterFilesContent) && body.starterFilesContent.length) {
      const name = String(body.name ?? '');
      starterFiles = writeStarterFiles(name, body.starterFilesContent);
    }
    const parsed = ScenarioConfigSchema.parse({ ...body, starterFiles });
    const p = resolveScenarioPath(scenariosDir(), parsed.name);
    if (fs.existsSync(p)) {
      res.status(409).json({ error: 'Scenario already exists; use PUT to edit' });
      return;
    }
    writeScenarioYaml(p, parsed);
    res.status(201).json({ scenario: parsed });
  });

  // PUT /api/scenarios/:name — edit (optionally rename)
  router.put('/:name', (req, res) => {
    const p = resolveAndValidate(req.params.name);
    if (!p) { res.status(400).json({ error: 'Invalid scenario name' }); return; }
    if (!fs.existsSync(p)) {
      res.status(404).json({ error: 'Scenario not found' });
      return;
    }
    const existing = loadScenario(p);
    const body = req.body ?? {};
    const newName = String(body.name ?? existing.name);
    const target = newName !== existing.name ? resolveScenarioPath(scenariosDir(), newName) : p;

    let starterFiles = body.starterFiles ?? existing.starterFiles;
    if (Array.isArray(body.starterFilesContent) && body.starterFilesContent.length) {
      starterFiles = writeStarterFiles(newName, body.starterFilesContent);
    }
    const parsed = ScenarioConfigSchema.parse({ ...existing, ...body, name: newName, starterFiles });
    writeScenarioYaml(target, parsed);
    if (target !== p && fs.existsSync(p)) fs.unlinkSync(p);
    res.json({ scenario: parsed });
  });

  // DELETE /api/scenarios/:name
  router.delete('/:name', (req, res) => {
    const p = resolveAndValidate(req.params.name);
    if (!p) { res.status(400).json({ error: 'Invalid scenario name' }); return; }
    if (!fs.existsSync(p)) {
      res.status(404).json({ error: 'Scenario not found' });
      return;
    }
    const scenario = loadScenario(p);
    fs.unlinkSync(p);
    if (scenario.starterFiles) {
      fs.rmSync(path.join(scenariosDir(), scenario.starterFiles), { recursive: true, force: true });
    }
    res.json({ deleted: req.params.name });
  });

  return router;
}
