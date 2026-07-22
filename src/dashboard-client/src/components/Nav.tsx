import { NavLink } from 'react-router-dom';
import { useSettings } from '../providers/SettingsProvider';
import { CacheStatePill } from './CacheStatePill';
import { cn } from '../lib/cn';

const PRIMARY_LINKS = [
  { to: '/', label: 'Home' },
  { to: '/scenarios', label: 'Scenarios' },
  { to: '/catalog', label: 'Catalog' },
  { to: '/leaderboard', label: 'Leaderboard' },
  { to: '/costs', label: 'Costs' },
  { to: '/comparisons', label: 'Comparisons' },
  { to: '/compare', label: 'Compare' },
];

const ADMIN_LINKS = [
  { to: '/ops', label: 'Ops' },
  { to: '/observability', label: 'Observability' },
  { to: '/anomalies', label: 'Anomalies' },
  { to: '/regression', label: 'Regression' },
  { to: '/schedules', label: 'Schedules' },
  { to: '/budget', label: 'Budget' },
  { to: '/runners', label: 'Runners' },
  { to: '/queues', label: 'Queues' },
  { to: '/prompts', label: 'Prompts' },
  { to: '/output-mappings', label: 'Mappings' },
  { to: '/settings', label: 'Settings' },
];

export function Nav() {
  const { theme, setTheme } = useSettings();
  const nextTheme = theme === 'dark' ? 'light' : theme === 'light' ? 'auto' : 'dark';
  return (
    <nav className="sticky top-0 z-50 flex h-16 items-center justify-between border-b border-border bg-bg-0/95 px-6 backdrop-blur">
      <div className="flex items-center gap-4">
        <span className="font-display text-20 font-700 text-accent">AI_ARENA</span>
        <div className="flex gap-1">
          {PRIMARY_LINKS.map(l => (
            <NavLink
              key={l.to}
              to={l.to}
              end={l.to === '/'}
              className={({ isActive }) => cn(
                'px-3 py-2 font-display text-14 font-500 transition-colors duration-80 ease-out-quart',
                isActive ? 'text-accent' : 'text-fg-1 hover:text-fg-0',
              )}
            >
              {l.label}
            </NavLink>
          ))}
          <span className="mx-1 text-fg-1 text-14 flex items-center">|</span>
          {ADMIN_LINKS.map(l => (
            <NavLink
              key={l.to}
              to={l.to}
              className={({ isActive }) => cn(
                'px-2 py-2 font-display text-12 font-500 transition-colors duration-80 ease-out-quart',
                isActive ? 'text-accent' : 'text-fg-1 hover:text-fg-0',
              )}
            >
              {l.label}
            </NavLink>
          ))}
        </div>
      </div>
      <div className="flex items-center gap-4">
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
