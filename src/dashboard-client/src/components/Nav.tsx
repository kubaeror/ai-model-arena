import { useState } from 'react';
import { NavLink } from 'react-router-dom';
import { Menu, X } from 'lucide-react';
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

function NavLinks({ links, size = 'sm' }: { links: typeof PRIMARY_LINKS; size?: 'sm' | 'md' }) {
  const isMd = size === 'md';
  return (
    <>
      {links.map(l => (
        <NavLink
          key={l.to}
          to={l.to}
          end={l.to === '/'}
          className={({ isActive }) => cn(
            'font-display font-500 transition-colors duration-80 ease-out-quart',
            isMd ? 'px-3 py-2 text-14' : 'px-2 py-2 text-12',
            isActive ? 'text-accent' : 'text-fg-1 hover:text-fg-0',
          )}
        >
          {l.label}
        </NavLink>
      ))}
    </>
  );
}

export function Nav() {
  const { theme, setTheme } = useSettings();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  const nextTheme = theme === 'dark' ? 'light' : theme === 'light' ? 'auto' : 'dark';

  return (
    <>
      <nav className="sticky top-0 z-50 flex h-16 items-center justify-between border-b border-border bg-bg-0/95 px-4 md:px-6 backdrop-blur">
        <div className="flex items-center gap-2 md:gap-4">
          <span className="font-display text-20 font-700 text-accent shrink-0">AI_ARENA</span>
          <div className="hidden md:flex gap-1 items-center">
            <NavLinks links={PRIMARY_LINKS} size="md" />
            <span className="mx-1 text-fg-1 text-14 hidden lg:flex items-center">|</span>
            <div className="hidden lg:flex items-center gap-1">
              <NavLinks links={ADMIN_LINKS} size="sm" />
            </div>
            <button
              onClick={() => setAdminOpen(v => !v)}
              className="lg:hidden px-2 py-2 font-display text-12 font-500 text-fg-1 hover:text-fg-0 transition-colors duration-80"
            >
              {adminOpen ? '▲' : 'More'}
            </button>
          </div>
        </div>
        <div className="flex items-center gap-2 md:gap-4">
          <CacheStatePill />
          <button
            onClick={() => setTheme(nextTheme)}
            aria-label={`Toggle theme (current: ${theme})`}
            className="h-8 w-8 rounded-inner hover:bg-bg-2 font-mono text-14 text-fg-1 hover:text-fg-0 flex items-center justify-center"
          >
            {theme === 'dark' ? '☾' : theme === 'light' ? '☀' : '◐'}
          </button>
          <button
            onClick={() => setMobileOpen(v => !v)}
            aria-label="Toggle menu"
            className="md:hidden h-8 w-8 rounded-inner hover:bg-bg-2 text-fg-1 flex items-center justify-center"
          >
            {mobileOpen ? <X size={18} /> : <Menu size={18} />}
          </button>
        </div>
      </nav>

      {adminOpen && (
        <div className="hidden md:flex lg:hidden sticky top-16 z-40 flex-wrap gap-1 border-b border-border bg-bg-0/95 px-6 py-2 backdrop-blur">
          <NavLinks links={ADMIN_LINKS} size="sm" />
        </div>
      )}

      {mobileOpen && (
        <div className="md:hidden fixed inset-0 top-16 z-40 bg-bg-0">
          <div className="flex flex-col p-4 gap-1 overflow-y-auto h-full pb-16">
            <div className="font-body text-12 text-fg-1 uppercase mb-2">Primary</div>
            <div className="flex flex-col gap-1 mb-4">
              {PRIMARY_LINKS.map(l => (
                <NavLink
                  key={l.to}
                  to={l.to}
                  end={l.to === '/'}
                  onClick={() => setMobileOpen(false)}
                  className={({ isActive }) => cn(
                    'px-3 py-2 font-display text-14 font-500 rounded-inner transition-colors duration-80',
                    isActive ? 'bg-accent/15 text-accent' : 'text-fg-1 hover:bg-bg-2 hover:text-fg-0',
                  )}
                >
                  {l.label}
                </NavLink>
              ))}
            </div>
            <div className="font-body text-12 text-fg-1 uppercase mb-2">Admin</div>
            <div className="flex flex-col gap-1">
              {ADMIN_LINKS.map(l => (
                <NavLink
                  key={l.to}
                  to={l.to}
                  onClick={() => setMobileOpen(false)}
                  className={({ isActive }) => cn(
                    'px-3 py-2 font-display text-14 font-500 rounded-inner transition-colors duration-80',
                    isActive ? 'bg-accent/15 text-accent' : 'text-fg-1 hover:bg-bg-2 hover:text-fg-0',
                  )}
                >
                  {l.label}
                </NavLink>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
