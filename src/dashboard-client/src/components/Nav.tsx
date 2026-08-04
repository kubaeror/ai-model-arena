import { useState, useRef, useEffect } from 'react';
import { NavLink } from 'react-router';
import { Menu, X, ChevronDown } from 'lucide-react';
import { useSettings } from '../providers/SettingsProvider';
import { CacheStatePill } from './CacheStatePill';
import { cn } from '../lib/cn';

const MAIN_LINKS = [
  { to: '/', label: 'Home' },
  { to: '/scenarios', label: 'Scenarios' },
  { to: '/catalog', label: 'Catalog' },
  { to: '/leaderboard', label: 'Leaderboard' },
  { to: '/costs', label: 'Costs' },
  { to: '/compare', label: 'Compare' },
  { to: '/observability', label: 'Observability' },
  { to: '/runners', label: 'Runners' },
  { to: '/settings', label: 'Settings' },
];

const MORE_LINKS = [
  { to: '/anomalies', label: 'Anomalies' },
  { to: '/regression', label: 'Regression' },
  { to: '/schedules', label: 'Schedules' },
  { to: '/budget', label: 'Budget' },
  { to: '/queues', label: 'Queues' },
  { to: '/prompts', label: 'Prompts' },
  { to: '/output-mappings', label: 'Mappings' },
  { to: '/ops', label: 'Ops' },
];

function NavLinkItem({ to, label, onClick, size = 'md' }: {
  to: string; label: string; onClick?: () => void; size?: 'sm' | 'md';
}) {
  const isMd = size === 'md';
  return (
    <NavLink
      to={to}
      end={to === '/'}
      onClick={onClick}
      aria-current="page"
      className={({ isActive }) => cn(
        'font-display font-500 transition-colors duration-80 ease-out-quart rounded-inner',
        isMd ? 'px-3 py-2 text-14' : 'px-3 py-2 text-14',
        isActive ? 'text-accent bg-accent/10' : 'text-fg-1 hover:text-fg-0 hover:bg-bg-2',
      )}
    >
      {label}
    </NavLink>
  );
}

export function Nav() {
  const { theme, setTheme } = useSettings();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  const nextTheme = theme === 'dark' ? 'light' : theme === 'light' ? 'auto' : 'dark';

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (moreRef.current && !moreRef.current.contains(e.target as HTMLElement)) {
        setMoreOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  return (
    <>
      <nav className="sticky top-0 z-50 flex h-16 items-center justify-between border-b border-border bg-bg-0/95 px-4 md:px-6 backdrop-blur">
        <div className="flex items-center gap-3 md:gap-5">
          <span className="font-display text-20 font-700 text-accent shrink-0">AI_ARENA</span>
          <div className="hidden md:flex gap-1 items-center">
            {MAIN_LINKS.map(l => (
              <NavLinkItem key={l.to} to={l.to} label={l.label} size="md" />
            ))}
            <div className="relative" ref={moreRef}>
              <button
                onClick={() => setMoreOpen(v => !v)}
                className={cn(
                  'font-display text-14 font-500 px-3 py-2 rounded-inner transition-colors duration-80 flex items-center gap-1',
                  moreOpen ? 'text-fg-0 bg-bg-2' : 'text-fg-1 hover:text-fg-0 hover:bg-bg-2',
                )}
              >
                More <ChevronDown size={12} className={cn('transition-transform', moreOpen && 'rotate-180')} />
              </button>
              {moreOpen && (
                <div className="absolute top-full left-0 mt-1 w-48 rounded-panel border border-border bg-bg-1 py-1 shadow-lg z-50">
                  {MORE_LINKS.map(l => (
                    <NavLinkItem
                      key={l.to}
                      to={l.to}
                      label={l.label}
                      size="sm"
                      onClick={() => setMoreOpen(false)}
                    />
                  ))}
                </div>
              )}
            </div>
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

      {mobileOpen && (
        <div className="md:hidden fixed inset-0 top-16 z-40 bg-bg-0" onClick={() => setMobileOpen(false)}>
          <div className="flex flex-col p-4 gap-1 overflow-y-auto h-full pb-16" onClick={e => e.stopPropagation()}>
            {MAIN_LINKS.map(l => (
              <NavLinkItem
                key={l.to}
                to={l.to}
                label={l.label}
                size="md"
                onClick={() => setMobileOpen(false)}
              />
            ))}
            <div className="font-body text-12 text-fg-1 uppercase mt-4 mb-1 px-3">More</div>
            {MORE_LINKS.map(l => (
              <NavLinkItem
                key={l.to}
                to={l.to}
                label={l.label}
                size="md"
                onClick={() => setMobileOpen(false)}
              />
            ))}
          </div>
        </div>
      )}
    </>
  );
}
