import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router';
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

const { logoutMock } = vi.hoisted(() => ({ logoutMock: vi.fn() }));

vi.mock('../../../src/hooks/useAuth', () => ({
  useAuth: () => ({
    token: 'token',
    username: 'admin',
    isAuthenticated: true,
    login: vi.fn(),
    logout: logoutMock,
  }),
}));

beforeEach(() => {
  logoutMock.mockClear();
});

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

  it('renders a Comparisons link to /comparisons', () => {
    render(<MemoryRouter><Nav /></MemoryRouter>);
    const link = screen.getByRole('link', { name: 'Comparisons' });
    expect(link).toHaveAttribute('href', '/comparisons');
  });

  it('renders the current username', () => {
    render(<MemoryRouter><Nav /></MemoryRouter>);
    expect(screen.getByText('admin')).toBeInTheDocument();
  });

  it('logs out and navigates to /login', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<Nav />} />
          <Route path="/login" element={<div>login-page</div>} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Logout' }));
    expect(logoutMock).toHaveBeenCalledTimes(1);
    expect(screen.getByText('login-page')).toBeInTheDocument();
  });
});
