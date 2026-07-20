import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Badge } from '../../../src/components/ui/Badge';

describe('Badge', () => {
  it('renders the value text', () => {
    render(<Badge variant="tier" value="S+" />);
    expect(screen.getByText('S+')).toBeInTheDocument();
  });

  it('applies tier variant class for S+', () => {
    render(<Badge variant="tier" value="S+" />);
    const badge = screen.getByText('S+');
    expect(badge.className).toContain('text-accent');
  });

  it('applies danger class for deprecated status', () => {
    render(<Badge variant="status" value="deprecated" />);
    const badge = screen.getByText('deprecated');
    expect(badge.className).toContain('text-danger');
  });

  it('applies info class for provider variant', () => {
    render(<Badge variant="provider" value="openai" />);
    const badge = screen.getByText('openai');
    expect(badge.className).toContain('text-info');
  });
});
