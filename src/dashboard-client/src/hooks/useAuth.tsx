import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { getToken, getUser, clearToken, login as apiLogin } from '../lib/api.js';

interface AuthContextValue {
  token: string | null;
  username: string | null;
  isAuthenticated: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setTokenState] = useState<string | null>(getToken());
  const [username, setUsername] = useState<string | null>(getUser());

  const login = useCallback(async (u: string, p: string) => {
    const r = await apiLogin(u, p);
    setTokenState(r.token);
    setUsername(r.username);
  }, []);

  const logout = useCallback(() => {
    clearToken();
    setTokenState(null);
    setUsername(null);
  }, []);

  return (
    <AuthContext.Provider value={{ token, username, isAuthenticated: !!token, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
