import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { AuthProvider, useAuth } from '../../src/hooks/useAuth';

const { clearTokenMock, logoutMock } = vi.hoisted(() => ({
  clearTokenMock: vi.fn(),
  logoutMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/lib/api', async () => {
  const actual = await vi.importActual('../../src/lib/api');
  return {
    ...actual,
    getToken: vi.fn().mockReturnValue(null),
    getUser: vi.fn().mockReturnValue(null),
    clearToken: clearTokenMock,
    login: vi.fn().mockResolvedValue({ token: 'new-token', username: 'testuser' }),
    logout: logoutMock,
  };
});

function TestConsumer() {
  const { isAuthenticated, token, username, login, logout } = useAuth();
  return (
    <div>
      <span data-testid="authenticated">{String(isAuthenticated)}</span>
      <span data-testid="token">{token ?? 'null'}</span>
      <span data-testid="username">{username ?? 'null'}</span>
      <button data-testid="login-btn" onClick={() => login('testuser', 'password')}>Login</button>
      <button data-testid="logout-btn" onClick={logout}>Logout</button>
    </div>
  );
}

describe('AuthProvider + useAuth', () => {
  beforeEach(() => {
    logoutMock.mockClear();
    clearTokenMock.mockClear();
  });

  it('starts as not authenticated', () => {
    render(<AuthProvider><TestConsumer /></AuthProvider>);
    expect(screen.getByTestId('authenticated').textContent).toBe('false');
  });

  it('authenticates after login', async () => {
    render(<AuthProvider><TestConsumer /></AuthProvider>);
    await act(async () => {
      screen.getByTestId('login-btn').click();
    });
    expect(screen.getByTestId('authenticated').textContent).toBe('true');
    expect(screen.getByTestId('token').textContent).toBe('new-token');
    expect(screen.getByTestId('username').textContent).toBe('testuser');
  });

  it('logs out', async () => {
    render(<AuthProvider><TestConsumer /></AuthProvider>);
    await act(async () => {
      screen.getByTestId('login-btn').click();
    });
    expect(screen.getByTestId('authenticated').textContent).toBe('true');
    await act(async () => {
      screen.getByTestId('logout-btn').click();
    });
    expect(screen.getByTestId('authenticated').textContent).toBe('false');
  });

  it('revokes the server session and clears local state on logout', async () => {
    render(<AuthProvider><TestConsumer /></AuthProvider>);
    await act(async () => {
      screen.getByTestId('login-btn').click();
    });

    await act(async () => {
      screen.getByTestId('logout-btn').click();
    });

    expect(logoutMock).toHaveBeenCalledTimes(1);
    expect(clearTokenMock).toHaveBeenCalled();
    expect(screen.getByTestId('authenticated').textContent).toBe('false');
  });

  it('clears local state even when the server logout call fails', async () => {
    logoutMock.mockRejectedValueOnce(new Error('network down'));
    render(<AuthProvider><TestConsumer /></AuthProvider>);
    await act(async () => {
      screen.getByTestId('login-btn').click();
    });

    await act(async () => {
      screen.getByTestId('logout-btn').click();
    });

    expect(clearTokenMock).toHaveBeenCalled();
    expect(screen.getByTestId('authenticated').textContent).toBe('false');
  });
});
