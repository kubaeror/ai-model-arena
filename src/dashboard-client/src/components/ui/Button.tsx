import { cva, type VariantProps } from 'class-variance-authority';
import type { ButtonHTMLAttributes } from 'react';
import { cn } from '../../lib/cn';

const buttonVariants = cva(
  'inline-flex items-center justify-center rounded-inner font-display font-500 transition-colors duration-80 ease-out-quart focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg-1 disabled:opacity-50 disabled:pointer-events-none active:scale-[0.97]',
  {
    variants: {
      variant: {
        primary: 'bg-accent text-bg-0 hover:bg-accent/90',
        ghost: 'bg-transparent text-fg-0 hover:bg-bg-2',
        danger: 'bg-danger text-bg-0 hover:bg-danger/90',
      },
      size: {
        sm: 'h-8 px-3 text-14',
        md: 'h-40 px-4 text-16',
        lg: 'h-12 px-6 text-20',
      },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export function Button({ className, variant, size, ...props }: ButtonProps) {
  return <button className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
