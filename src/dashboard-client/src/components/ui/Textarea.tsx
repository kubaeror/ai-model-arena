import { forwardRef, type TextareaHTMLAttributes } from 'react';
import { cn } from '../../lib/cn';

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => {
    return (
      <textarea
        className={cn(
          'w-full rounded-inner border border-border bg-bg-2 px-3 py-2 font-mono text-14 text-fg-0',
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
Textarea.displayName = 'Textarea';
