import { useCallback, useEffect, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import { cn } from '../../lib/cn';

interface SearchInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  debounceMs?: number;
  className?: string;
}

export function SearchInput({
  value,
  onChange,
  placeholder = 'Search…',
  debounceMs = 200,
  className,
}: SearchInputProps) {
  const [local, setLocal] = useState(value);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    setLocal(value);
  }, [value]);

  const handleChange = useCallback(
    (next: string) => {
      setLocal(next);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => onChange(next), debounceMs);
    },
    [onChange, debounceMs],
  );

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return (
    <div className={cn('relative', className)}>
      <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-1 pointer-events-none" />
      <input
        type="text"
        value={local}
        onChange={e => handleChange(e.target.value)}
        placeholder={placeholder}
        className="h-40 w-full rounded-inner border border-border bg-bg-2 pl-9 pr-8 font-mono text-14 text-fg-0 placeholder:text-fg-1/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      />
      {local && (
        <button
          onClick={() => { setLocal(''); onChange(''); }}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-fg-1 hover:text-fg-0"
          aria-label="Clear search"
        >
          <X size={14} />
        </button>
      )}
    </div>
  );
}
