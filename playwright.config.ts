import { defineConfig, devices } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Fresh temp workspace for each e2e run — the dashboard server boots against a
// brand-new SQLite DB and output root (never touches the repo's outputs/).
// Absolute paths are computed here because webServer.env is applied to a child
// process and must not depend on the Playwright runner's cwd.
const e2eRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-e2e-'));

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 30_000,
  retries: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:4000',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run dashboard:build && node dist/dashboard-server/server.js',
    url: 'http://localhost:4000/health',
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      ARENA_SKIP_ENV_CHECK: '1',
      DASHBOARD_PORT: '4000',
      DASHBOARD_USERNAME: 'admin',
      DASHBOARD_PASSWORD: 'playwright-pass',
      DASHBOARD_JWT_SECRET: 'playwright-dev-jwt-secret-0123456789abcdef0123456789abcdef',
      WEBHOOK_SECRET_KEY: '0'.repeat(64),
      DB_DRIVER: 'sqlite',
      ARENA_DB_PATH: path.join(e2eRoot, 'arena.db'),
      OUTPUT_ROOT: e2eRoot,
    },
  },
});
