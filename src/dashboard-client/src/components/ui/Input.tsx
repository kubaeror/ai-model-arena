import { forwardRef, type InputHTMLAttributes } from 'react';
import { cn } from '../../lib/cn';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          'h-40 w-full rounded-inner border border-border bg-bg-2 px-3 font-mono text-14 text-fg-0',
          'placeholder:text-fg-1/50',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-0',
          'disabled:opacity-50 disabled:cursor-not-allowed',
          className,
        )}
        ref={ref}
        {...props}
      />
    );
  },
);
Input.displayName = 'Input';
