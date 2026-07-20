import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Tabs } from '../../../src/components/ui/Tabs';

describe('Tabs', () => {
  const items = [
    { id: 'overview', label: 'Overview' },
    { id: 'benchmarks', label: 'Benchmarks' },
    { id: 'metrics', label: 'Metrics' },
  ];

  it('renders all tab labels', () => {
    render(<Tabs items={items} value="overview" onChange={() => {}} />);
    expect(screen.getByRole('tab', { name: 'Overview' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Benchmarks' })).toBeInTheDocument();
  });

  it('marks the active tab with aria-selected', () => {
    render(<Tabs items={items} value="overview" onChange={() => {}} />);
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Benchmarks' })).toHaveAttribute('aria-selected', 'false');
  });

  it('calls onChange with tab id when clicked', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Tabs items={items} value="overview" onChange={onChange} />);
    await user.click(screen.getByRole('tab', { name: 'Benchmarks' }));
    expect(onChange).toHaveBeenCalledWith('benchmarks');
  });

  it('supports arrow key navigation', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Tabs items={items} value="overview" onChange={onChange} />);
    const overviewTab = screen.getByRole('tab', { name: 'Overview' });
    overviewTab.focus();
    await user.keyboard('{ArrowRight}');
    expect(onChange).toHaveBeenCalledWith('benchmarks');
  });
});
