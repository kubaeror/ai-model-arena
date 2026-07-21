import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Login } from '../../src/pages/Login';

vi.mock('../../src/hooks/useAuth', () => ({
  useAuth: () => ({
    isAuthenticated: false,
    token: null,
    username: null,
    login: vi.fn(),
    logout: vi.fn(),
  }),
}));

describe('Login', () => {
  it('renders the sign-in heading', () => {
    render(<MemoryRouter><Login /></MemoryRouter>);
    expect(screen.getByText(/Sign in to the dashboard/i)).toBeInTheDocument();
  });

  it('renders username input', () => {
    render(<MemoryRouter><Login /></MemoryRouter>);
    expect(screen.getByText('Username')).toBeInTheDocument();
  });

  it('renders password input', () => {
    render(<MemoryRouter><Login /></MemoryRouter>);
    expect(screen.getByText('Password')).toBeInTheDocument();
  });

  it('renders sign-in button', () => {
    render(<MemoryRouter><Login /></MemoryRouter>);
    expect(screen.getByRole('button', { name: /Sign in/i })).toBeInTheDocument();
  });
});
