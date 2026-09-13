import { describe, it, expect, beforeEach, vi } from 'vitest';

const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => store.set(k, v),
  removeItem: (k: string) => store.delete(k),
  clear: () => store.clear(),
});

import {
  getToken, clearToken, getUser, login, api, updateSchedule,
  getSessionMessages, getSessionCalls,
} from '../../src/lib/api.js';

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

describe('session transcript pagination', () => {
  const okJson = (body: unknown) => ({
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
  });

  it('getSessionMessages sends limit and unwraps the payload', async () => {
    let captured: string | undefined;
    vi.stubGlobal('fetch', async (url: string) => {
      captured = url;
      return okJson({ messages: [{ id: 'm1' }], limit: 200, offset: 0 });
    });

    const messages = await getSessionMessages('sess 1', { limit: 200 });

    expect(captured).toBe('/api/sessions/sess%201/messages?limit=200');
    expect(messages).toEqual([{ id: 'm1' }]);
    vi.unstubAllGlobals();
  });

  it('getSessionMessages sends limit and offset for later pages', async () => {
    let captured: string | undefined;
    vi.stubGlobal('fetch', async (url: string) => {
      captured = url;
      return okJson({ messages: [{ id: 'm200' }], limit: 200, offset: 200 });
    });

    const messages = await getSessionMessages('s1', { limit: 200, offset: 200 });

    expect(captured).toBe('/api/sessions/s1/messages?limit=200&offset=200');
    expect(messages).toEqual([{ id: 'm200' }]);
    vi.unstubAllGlobals();
  });

  it('getSessionCalls sends limit and offset for later pages', async () => {
    let captured: string | undefined;
    vi.stubGlobal('fetch', async (url: string) => {
      captured = url;
      return okJson({ calls: [{ id: 'c200' }], limit: 200, offset: 200 });
    });

    const calls = await getSessionCalls('s1', { limit: 200, offset: 200 });

    expect(captured).toBe('/api/sessions/s1/calls?limit=200&offset=200');
    expect(calls).toEqual([{ id: 'c200' }]);
    vi.unstubAllGlobals();
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
