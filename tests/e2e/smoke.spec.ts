import { test, expect, request, type Page } from '@playwright/test';

// Mirrors webServer.env in playwright.config.ts — auth.ts uses
// DASHBOARD_PASSWORD directly when set (no one-time dev password generated),
// so these exact credentials must pass.
const USERNAME = 'admin';
const PASSWORD = 'playwright-pass';

// The dashboard's Field component renders labels as <span>s without htmlFor,
// so getByLabel does not match. Fill via the label span's following input/
// textarea sibling instead.
async function fillField(page: Page, label: string, value: string): Promise<void> {
  await page
    .getByText(label, { exact: true })
    .locator('xpath=following-sibling::input | following-sibling::textarea')
    .fill(value);
}

async function login(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'AI_ARENA' })).toBeVisible();
  await page.locator('input[autocomplete="username"]').fill(USERNAME);
  await page.locator('input[autocomplete="current-password"]').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Mission Control' })).toBeVisible();
}

let createdScenario: string | undefined;

test.afterAll(async () => {
  // Scenario creation persists a YAML file into configs/scenarios/ — clean it
  // up so e2e runs never pollute the repo, even on failure.
  if (!createdScenario) return;
  const api = await request.newContext({ baseURL: 'http://localhost:4000' });
  try {
    const res = await api.post('/api/auth/login', { data: { username: USERNAME, password: PASSWORD } });
    if (res.ok()) {
      const { token } = (await res.json()) as { token: string };
      await api.delete(`/api/scenarios/${createdScenario}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
    }
  } finally {
    await api.dispose();
  }
});

test('login with dev credentials lands on Home with stat tiles', async ({ page }) => {
  await login(page);
  await expect(page.getByText('Active runs', { exact: true })).toBeVisible();
  await expect(page.getByText('Models in DB', { exact: true })).toBeVisible();
  await expect(page.getByText('Cache sources', { exact: true })).toBeVisible();
});

test('nav to Catalog and Leaderboard renders their pages', async ({ page }) => {
  await login(page);
  await page.getByRole('link', { name: 'Catalog' }).click();
  await expect(page.getByRole('heading', { name: 'Catalog' })).toBeVisible();
  await page.getByRole('link', { name: 'Leaderboard' }).click();
  await expect(page.getByRole('heading', { name: 'Leaderboard' })).toBeVisible();
});

test('create a scenario via ScenarioForm and see it in the list', async ({ page }) => {
  const name = `e2e-${Date.now()}`;
  await login(page);

  await page.getByRole('link', { name: 'Scenarios' }).click();
  await expect(page.getByRole('heading', { name: 'Scenarios' })).toBeVisible();
  await page.getByRole('button', { name: 'New scenario' }).click();

  await page.getByPlaceholder('my-task').fill(name);
  await fillField(page, 'System prompt', 'You are a senior engineer. Be concise and test-driven.');
  await fillField(page, 'Task (initial user prompt)', 'Implement a fibonacci function in src/index.js so the tests pass.');

  await page.getByRole('button', { name: 'Create scenario' }).click();
  createdScenario = name;
  await expect(page.getByRole('heading', { name: 'Scenarios' })).toBeVisible();
  await expect(page.getByText(name, { exact: true })).toBeVisible();
});
