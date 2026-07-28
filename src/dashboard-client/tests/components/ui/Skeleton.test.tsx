import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Skeleton, SkeletonLine, SkeletonCard, SkeletonRow, SkeletonTable, SkeletonStats } from '../../../src/components/ui/Skeleton';

describe('Skeleton', () => {
  it('renders with pulse animation', () => {
    const { container } = render(<Skeleton className="h-4" />);
    const el = container.firstChild as HTMLElement;
    expect(el.className).toContain('animate-pulse');
    expect(el.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('SkeletonLine', () => {
  it('renders a full-width skeleton line', () => {
    const { container } = render(<SkeletonLine />);
    const el = container.firstChild as HTMLElement;
    expect(el.className).toContain('w-full');
    expect(el.className).toContain('h-4');
  });
});

describe('SkeletonCard', () => {
  it('renders a card-shaped skeleton', () => {
    const { container } = render(<SkeletonCard />);
    const el = container.firstChild as HTMLElement;
    expect(el.className).toContain('h-32');
    expect(el.className).toContain('rounded-panel');
  });
});

describe('SkeletonRow', () => {
  it('renders the correct number of columns', () => {
    const { container } = render(<SkeletonRow columns={3} />);
    const children = container.querySelectorAll('[aria-hidden="true"]');
    expect(children.length).toBe(3);
  });
});

describe('SkeletonTable', () => {
  it('renders header row + data rows', () => {
    render(<SkeletonTable columns={3} rows={2} />);
    const rows = document.querySelectorAll('[aria-hidden="true"]');
    // header (3 cells) + 2 data rows (3 cells each) = 9
    expect(rows.length).toBe(9);
  });
});

describe('SkeletonStats', () => {
  it('renders the correct number of stat cards', () => {
    const { container } = render(<SkeletonStats count={4} />);
    const cards = container.querySelectorAll('[aria-hidden="true"]');
    expect(cards.length).toBe(4);
  });
});
