import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import {
  loadModelsConfig,
  ModelConfigSchema,
  ModelsFileSchema,
  type ModelConfig,
} from '../../config.js';
import { findProjectRoot } from '../../paths.js';

function modelsPath(): string {
  return path.join(findProjectRoot(), 'configs', 'models.yaml');
}

/**
 * Model configs only ever contain `apiKeyEnv` (the NAME of an env var), never a
 * raw key value — so returning them is safe. We strip nothing because there is
 * no secret to strip; the env var name is exactly what the UI should show.
 */
function sanitize(m: ModelConfig): ModelConfig {
  return m;
}

function persistModels(models: ModelConfig[]): ModelConfig[] {
  const validated = ModelsFileSchema.parse({ models });
  fs.mkdirSync(path.dirname(modelsPath()), { recursive: true });
  fs.writeFileSync(modelsPath(), yaml.dump({ models: validated.models }, { lineWidth: 120 }));
  return validated.models;
}

export function createModelsRouter(): Router {
  const router = Router();

  // GET /api/models — list configured models
  router.get('/', (_req, res) => {
    const { models } = loadModelsConfig(modelsPath());
    res.json({ models: models.map(sanitize) });
  });

  // POST /api/models — add or update a model (upsert by name)
  router.post('/', (req, res) => {
    const parsed = ModelConfigSchema.parse(req.body);
    const file = loadModelsConfig(modelsPath());
    const idx = file.models.findIndex((m) => m.name === parsed.name);
    if (idx >= 0) file.models[idx] = parsed;
    else file.models.push(parsed);
    const saved = persistModels(file.models);
    res.status(idx >= 0 ? 200 : 201).json({ models: saved.map(sanitize) });
  });

  // DELETE /api/models/:name — remove a model
  router.delete('/:name', (req, res) => {
    const name = req.params.name;
    const file = loadModelsConfig(modelsPath());
    const next = file.models.filter((m) => m.name !== name);
    if (next.length === file.models.length) {
      res.status(404).json({ error: `Model "${name}" not found` });
      return;
    }
    const saved = persistModels(next);
    res.json({ models: saved.map(sanitize) });
  });

  return router;
}
