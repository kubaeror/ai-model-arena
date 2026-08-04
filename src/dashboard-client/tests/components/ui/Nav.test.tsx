import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { Nav } from '../../../src/components/Nav';

vi.mock('../../../src/hooks/useCache', () => ({
  useCacheStats: () => ({ data: [], isLoading: false }),
}));

vi.mock('../../../src/providers/SettingsProvider', () => ({
  useSettings: () => ({
    theme: 'dark' as const,
    setTheme: vi.fn(),
  }),
}));

describe('Nav', () => {
  it('renders the brand name', () => {
    render(<MemoryRouter><Nav /></MemoryRouter>);
    expect(screen.getByText('AI_ARENA')).toBeInTheDocument();
  });

  it('renders primary links', () => {
    render(<MemoryRouter><Nav /></MemoryRouter>);
    expect(screen.getByText('Home')).toBeInTheDocument();
    expect(screen.getByText('Catalog')).toBeInTheDocument();
  });

  it('renders More dropdown', () => {
    render(<MemoryRouter><Nav /></MemoryRouter>);
    expect(screen.getByText('More')).toBeInTheDocument();
  });
});
