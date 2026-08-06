import { describe, it, expect, beforeEach, vi } from 'vitest';

const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => store.set(k, v),
  removeItem: (k: string) => store.delete(k),
  clear: () => store.clear(),
});

import { getToken, clearToken, getUser, login, api, updateSchedule } from '../../src/lib/api.js';

describe('api namespace', () => {
  it('exposes put used by SecretsPanel', () => {
    expect(typeof api.put).toBe('function');
  });
});

describe('getToken / clearToken / login', () => {
  beforeEach(() => store.clear());

  async function loginAsAdmin() {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ token: 'jwt-token-123', username: 'admin' }),
    }));
    await login('admin', 'secret');
  }

  it('returns null when no token set', () => {
    expect(getToken()).toBeNull();
  });

  it('stores token after login', async () => {
    await loginAsAdmin();
    expect(getToken()).toBe('jwt-token-123');
  });

  it('stores username after login', async () => {
    await loginAsAdmin();
    expect(getUser()).toBe('admin');
  });

  it('returns null after clearToken', async () => {
    await loginAsAdmin();
    clearToken();
    expect(getToken()).toBeNull();
    expect(getUser()).toBeNull();
  });
});

describe('updateSchedule', () => {
  it('PATCHes /api/schedules/:id with the enabled flag and returns the schedule', async () => {
    const okJson = (body: unknown) => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => body,
    });
    let captured: { url: string; init: RequestInit } | undefined;
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      captured = { url, init };
      return okJson({ id: 's1', scenario: 'x', models: [], cron: '* * * * *', enabled: false, state: null });
    });

    const result = await updateSchedule('s1', { enabled: false });

    expect(captured?.url).toBe('/api/schedules/s1');
    expect(captured?.init?.method).toBe('PATCH');
    expect(JSON.parse(captured?.init?.body as string)).toEqual({ enabled: false });
    expect(result.enabled).toBe(false);
    vi.unstubAllGlobals();
  });
});
