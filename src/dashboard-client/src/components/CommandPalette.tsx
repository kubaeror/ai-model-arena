import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router';
import { cn } from '../lib/cn';

interface CommandItem {
  id: string;
  label: string;
  href?: string;
  action?: () => void;
  category: string;
}

const COMMANDS: CommandItem[] = [
  { id: 'home', label: 'Home', href: '/', category: 'Pages' },
  { id: 'scenarios', label: 'Scenarios', href: '/scenarios', category: 'Pages' },
  { id: 'catalog', label: 'Catalog', href: '/catalog', category: 'Pages' },
  { id: 'leaderboard', label: 'Leaderboard', href: '/leaderboard', category: 'Pages' },
  { id: 'costs', label: 'Cost Leaderboard', href: '/costs', category: 'Pages' },
  { id: 'compare', label: 'Compare Models', href: '/compare', category: 'Pages' },
  { id: 'observability', label: 'Observability', href: '/observability', category: 'Pages' },
  { id: 'runners', label: 'Runners', href: '/runners', category: 'Pages' },
  { id: 'settings', label: 'Settings', href: '/settings', category: 'Pages' },
  { id: 'ops', label: 'Ops Console', href: '/ops', category: 'Pages' },
  { id: 'anomalies', label: 'Anomalies', href: '/anomalies', category: 'Pages' },
  { id: 'schedules', label: 'Schedules', href: '/schedules', category: 'Pages' },
  { id: 'budget', label: 'Budget', href: '/budget', category: 'Pages' },
  { id: 'comparisons', label: 'Comparisons', href: '/comparisons', category: 'Pages' },
  { id: 'regression', label: 'Regression', href: '/regression', category: 'Pages' },
  { id: 'queues', label: 'Queues', href: '/queues', category: 'Pages' },
  { id: 'prompts', label: 'Prompts', href: '/prompts', category: 'Pages' },
  { id: 'mappings', label: 'Output Mappings', href: '/output-mappings', category: 'Pages' },
];

export function useCommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  const filtered = query
    ? COMMANDS.filter(c =>
        c.label.toLowerCase().includes(query.toLowerCase()) ||
        c.category.toLowerCase().includes(query.toLowerCase())
      )
    : COMMANDS;

  const selected = filtered[selectedIndex];

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setOpen(v => !v);
        setQuery('');
        setSelectedIndex(0);
      }
      if (e.key === 'Escape' && open) {
        setOpen(false);
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open]);

  useEffect(() => {
    if (open) {
      const timer = setTimeout(() => inputRef.current?.focus(), 50);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [open]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(i => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(i => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && selected) {
      e.preventDefault();
      if (selected.href) {
        navigate(selected.href);
      } else if (selected.action) {
        selected.action();
      }
      setOpen(false);
      setQuery('');
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  }, [selected, filtered, navigate]);

  const execute = useCallback((item: CommandItem) => {
    if (item.href) navigate(item.href);
    if (item.action) item.action();
    setOpen(false);
    setQuery('');
  }, [navigate]);

  const toggle = useCallback(() => {
    setOpen(v => !v);
    setQuery('');
    setSelectedIndex(0);
  }, []);

  return {
    open,
    setOpen,
    toggle,
    query,
    setQuery,
    selectedIndex,
    setSelectedIndex,
    filtered,
    selected,
    inputRef,
    handleKeyDown,
    execute,
  };
}

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  query: string;
  onQueryChange: (q: string) => void;
  filtered: CommandItem[];
  selectedIndex: number;
  selected: CommandItem | undefined;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onKeyDown: (e: React.KeyboardEvent) => void;
  onSelect: (item: CommandItem) => void;
}

export function CommandPalette({
  open, onClose, query, onQueryChange, filtered,
  selectedIndex, selected, inputRef, onKeyDown, onSelect,
}: CommandPaletteProps) {
  if (!open) return null;
  void selected; // unused but kept for potential future use

  return (
    <div className="fixed inset-0 z-200 flex items-start justify-center pt-[20vh]" onClick={onClose}>
      <div className="absolute inset-0 bg-bg-0/60" aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="relative z-10 w-full max-w-lg rounded-panel border border-border bg-bg-1 shadow-2xl overflow-hidden"
        onKeyDown={onKeyDown}
      >
        <div className="flex items-center border-b border-border px-4">
          <span className="text-fg-1 font-mono text-12 mr-2">⌘</span>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={e => onQueryChange(e.target.value)}
            placeholder="Search pages..."
            className="flex-1 h-12 bg-transparent font-mono text-14 text-fg-0 placeholder-fg-1 focus:outline-none"
            autoComplete="off"
            spellCheck={false}
          />
          <button
            onClick={onClose}
            className="font-mono text-12 text-fg-1 hover:text-fg-0 px-2 py-1 rounded-inner"
            aria-label="Close"
          >
            Esc
          </button>
        </div>
        <div className="max-h-80 overflow-auto nice-scroll py-2">
          {filtered.length === 0 ? (
            <div className="px-4 py-8 text-center font-body text-14 text-fg-1">
              No results for "{query}"
            </div>
          ) : (
            filtered.map((item, i) => (
              <button
                key={item.id}
                onMouseDown={e => e.preventDefault()}
                onClick={() => onSelect(item)}
                className={cn(
                  'w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors duration-80',
                  i === selectedIndex ? 'bg-accent/10' : 'hover:bg-bg-2',
                )}
              >
                <span className="font-mono text-14 text-fg-0 truncate">{item.label}</span>
                <span className="font-mono text-12 text-fg-1 ml-auto shrink-0">{item.category}</span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
