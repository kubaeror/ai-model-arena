import { NavLink } from 'react-router-dom';
import { useSettings } from '../providers/SettingsProvider';
import { CacheStatePill } from './CacheStatePill';
import { cn } from '../lib/cn';

const LINKS = [
  { to: '/', label: 'Home' },
  { to: '/catalog', label: 'Catalog' },
  { to: '/leaderboard', label: 'Leaderboard' },
  { to: '/compare', label: 'Compare' },
  { to: '/ops', label: 'Ops' },
  { to: '/settings', label: 'Settings' },
];

export function Nav() {
  const { theme, setTheme } = useSettings();
  const nextTheme = theme === 'dark' ? 'light' : theme === 'light' ? 'auto' : 'dark';
  return (
    <nav className="sticky top-0 z-50 flex h-64 items-center justify-between border-b border-border bg-bg-0/95 px-24 backdrop-blur">
      <div className="flex items-center gap-32">
        <span className="font-display text-20 font-700 text-accent">AI_ARENA</span>
        <div className="flex gap-4">
          {LINKS.map(l => (
            <NavLink
              key={l.to}
              to={l.to}
              end={l.to === '/'}
              className={({ isActive }) => cn(
                'px-12 py-8 font-display text-14 font-500 transition-colors duration-80 ease-out-quart',
                isActive ? 'text-accent' : 'text-fg-1 hover:text-fg-0',
              )}
            >
              {l.label}
            </NavLink>
          ))}
        </div>
      </div>
      <div className="flex items-center gap-16">
        <CacheStatePill />
        <button
          onClick={() => setTheme(nextTheme)}
          aria-label={`Toggle theme (current: ${theme})`}
          className="h-40 w-40 rounded-inner hover:bg-bg-2 font-mono text-14 text-fg-1 hover:text-fg-0"
        >
          {theme === 'dark' ? '☾' : theme === 'light' ? '☀' : '◐'}
        </button>
      </div>
    </nav>
  );
}
