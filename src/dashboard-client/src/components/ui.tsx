import type { ButtonHTMLAttributes, InputHTMLAttributes, TextareaHTMLAttributes, SelectHTMLAttributes, ReactNode } from 'react';
import { cn } from '../lib/cn.js';

export function Button({
  className,
  variant = 'default',
  size = 'md',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'outline' | 'ghost' | 'destructive';
  size?: 'sm' | 'md';
}) {
  return (
    <button
      className={cn(
        'inline-flex items-center justify-center rounded-md font-medium transition-colors disabled:opacity-50 disabled:pointer-events-none',
        size === 'sm' ? 'h-2 px-3 text-xs' : 'h-9 px-1 text-sm',
        variant === 'default' && 'bg-accent text-bg-0 hover:bg-accent/90',
        variant === 'outline' && 'border border-border text-fg-0 hover:bg-bg-2/20',
        variant === 'ghost' && 'hover:bg-bg-2/20',
        variant === 'destructive' && 'bg-red-600 text-white hover:bg-red-700',
        className,
      )}
      {...props}
    />
  );
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('rounded-panel border border-border bg-bg-1', className)}>{children}</div>;
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn('h-9 w-full rounded-md border border-border bg-bg-0 px-3 text-sm outline-none focus:border-accent', className)} {...props} />;
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn('w-full rounded-md border border-border bg-bg-0 p-3 text-sm outline-none focus:border-accent', className)} {...props} />;
}

export function Select({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cn('h-9 w-full rounded-md border border-border bg-bg-0 px-3 text-sm outline-none focus:border-accent', className)} {...props}>
      {children}
    </select>
  );
}

export function Label({ children, className }: { children: ReactNode; className?: string }) {
  return <label className={cn('block text-xs font-medium text-fg-1 mb-1', className)}>{children}</label>;
}

export function Badge({ children, color = 'slate' }: { children: ReactNode; color?: 'green' | 'red' | 'yellow' | 'slate' | 'blue' }) {
  const colors: Record<string, string> = {
    green: 'bg-green-500/15 text-green-400 border-green-500/30',
    red: 'bg-red-500/15 text-red-400 border-red-500/30',
    yellow: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30',
    blue: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
    slate: 'bg-bg-2/15 text-fg-1 border-border',
  };
  return <span className={cn('inline-flex items-center rounded-full border px-2 py-0.5 text-xs', colors[color])}>{children}</span>;
}

export function Spinner() {
  return <div className="h-1 w-1 animate-spin rounded-full border-2 border-border border-t-accent" />;
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <Label>{label}</Label>
      {children}
    </div>
  );
}
