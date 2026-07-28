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

  it('applies failure variant for deprecated status', () => {
    render(<Badge variant="status" value="deprecated" />);
    const badge = screen.getByText('deprecated');
    expect(badge.className).toContain('text-danger');
  });

  it('applies provider variant', () => {
    render(<Badge variant="provider" value="openai" />);
    const badge = screen.getByText('openai');
    expect(badge.className).toContain('text-info');
  });

  it('applies success variant', () => {
    render(<Badge variant="success" value="PASS" />);
    const badge = screen.getByText('PASS');
    expect(badge.className).toContain('text-accent');
  });

  it('applies failure variant', () => {
    render(<Badge variant="failure" value="FAIL" />);
    const badge = screen.getByText('FAIL');
    expect(badge.className).toContain('text-danger');
  });

  it('renders children when no value provided', () => {
    render(<Badge variant="neutral">Custom Text</Badge>);
    expect(screen.getByText('Custom Text')).toBeInTheDocument();
  });

  it('maps tier PASS to success variant', () => {
    render(<Badge variant="tier" value="PASS" />);
    const badge = screen.getByText('PASS');
    expect(badge.className).toContain('text-accent');
  });

  it('maps tier FAIL to failure variant', () => {
    render(<Badge variant="tier" value="FAIL" />);
    const badge = screen.getByText('FAIL');
    expect(badge.className).toContain('text-danger');
  });

  it('defaults to neutral variant', () => {
    render(<Badge value="unknown" />);
    const badge = screen.getByText('unknown');
    expect(badge.className).toContain('text-fg-1');
    expect(badge.className).toContain('border-border');
  });
});
