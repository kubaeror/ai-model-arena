import { describe, it, expect, beforeEach, vi } from 'vitest';

const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => store.set(k, v),
  removeItem: (k: string) => store.delete(k),
  clear: () => store.clear(),
});

import { getToken, setToken, clearToken, getUser } from '../../src/lib/api.js';

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
