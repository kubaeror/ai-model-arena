import { cn } from '../../lib/cn';

interface SelectOption {
  value: string;
  label: string;
}

interface SelectProps {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  label?: string;
  className?: string;
}

export function Select({ value, options, onChange, label, className }: SelectProps) {
  return (
    <label className={cn('flex flex-col gap-1', className)}>
      {label && <span className="font-body text-12 text-fg-1 uppercase">{label}</span>}
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        className="h-40 px-3 rounded-inner border border-border bg-bg-2 font-mono text-14 text-fg-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        {options.map(opt => (
          <option key={opt.value} value={opt.value}>{opt.label}</option>
        ))}
      </select>
    </label>
  );
}
