import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

type Theme = 'auto' | 'dark' | 'light';

interface SettingsContextValue {
  theme: Theme;
  setTheme: (t: Theme) => void;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

const STORAGE_KEY = 'arena_theme';

function resolveTheme(t: Theme): 'dark' | 'light' {
  if (t === 'dark') return 'dark';
  if (t === 'light') return 'light';
  if (typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark';
  return 'light';
}

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => {
    if (typeof localStorage === 'undefined') return 'dark';
    return (localStorage.getItem(STORAGE_KEY) as Theme) ?? 'dark';
  });

  useEffect(() => {
    const resolved = resolveTheme(theme);
    document.documentElement.dataset.theme = resolved;
    localStorage.setItem(STORAGE_KEY, theme);
  }, [theme]);

  return (
    <SettingsContext.Provider value={{ theme, setTheme: setThemeState }}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings(): SettingsContextValue {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error('useSettings must be used within SettingsProvider');
  return ctx;
}
