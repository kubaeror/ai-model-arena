import { describe, it, expect, beforeEach, vi } from 'vitest';

const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => store.set(k, v),
  removeItem: (k: string) => store.delete(k),
  clear: () => store.clear(),
});

import { getToken, setToken, clearToken, getUser, api, updateSchedule } from '../../src/lib/api.js';

describe('api namespace', () => {
  it('exposes put used by SecretsPanel', () => {
    expect(typeof api.put).toBe('function');
  });
});

describe('getToken / setToken / clearToken', () => {
  beforeEach(() => store.clear());

  it('returns null when no token set', () => {
    expect(getToken()).toBeNull();
  });

  it('returns stored token after setToken', () => {
    setToken('jwt-token-123', 'admin');
    expect(getToken()).toBe('jwt-token-123');
  });

  it('returns username after setToken', () => {
    setToken('jwt-token-123', 'admin');
    expect(getUser()).toBe('admin');
  });

  it('returns null after clearToken', () => {
    setToken('jwt-token-123', 'admin');
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
