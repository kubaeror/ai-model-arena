import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Skeleton } from '../../../src/components/ui/Skeleton';

describe('Skeleton', () => {
  it('renders with pulse animation', () => {
    const { container } = render(<Skeleton className="h-4" />);
    const el = container.firstChild as HTMLElement;
    expect(el.className).toContain('animate-pulse');
    expect(el.getAttribute('aria-hidden')).toBe('true');
  });
});
