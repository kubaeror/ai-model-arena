import { useRef, type KeyboardEvent } from 'react';
import { cn } from '../../lib/cn';

interface TabItem {
  id: string;
  label: string;
}

interface TabsProps {
  items: TabItem[];
  value: string;
  onChange: (id: string) => void;
  className?: string;
}

export function Tabs({ items, value, onChange, className }: TabsProps) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});

  function handleKeyDown(e: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      const next = items[(index + 1) % items.length];
      onChange(next!.id);
      refs.current[next!.id]?.focus();
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      const prev = items[(index - 1 + items.length) % items.length];
      onChange(prev!.id);
      refs.current[prev!.id]?.focus();
    }
  }

  return (
    <div role="tablist" className={cn('flex gap-4 border-b border-border', className)}>
      {items.map((item, i) => (
        <button
          key={item.id}
          ref={el => { refs.current[item.id] = el; }}
          role="tab"
          aria-selected={value === item.id}
          tabIndex={value === item.id ? 0 : -1}
          onClick={() => onChange(item.id)}
          onKeyDown={e => handleKeyDown(e, i)}
          className={cn(
            'px-16 py-12 font-display text-14 font-500 border-b-2 -mb-px transition-colors duration-80 ease-out-quart',
            value === item.id ? 'border-accent text-fg-0' : 'border-transparent text-fg-1 hover:text-fg-0',
          )}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
