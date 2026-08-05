import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { Suspense } from 'react';
import { Budget } from '../../src/pages/Budget';

const { budget, getBudgetMock } = vi.hoisted(() => {
  const budget = {
    global: { daily: { spent: 5.12, limit: 100 }, monthly: { spent: 50.55, limit: 1000 } },
    models: {
      'gpt-4o': { daily: { spent: 3.1, limit: 20 }, monthly: { spent: 30.25, limit: 200 } },
      'claude-3.7': { daily: { spent: 2.02, limit: null }, monthly: { spent: 20.3, limit: null } },
    },
  };
  return { budget, getBudgetMock: vi.fn().mockResolvedValue(budget) };
});

vi.mock('../../src/lib/api', async () => {
  const actual = await vi.importActual('../../src/lib/api');
  return { ...actual, getBudget: getBudgetMock };
});

function renderWithProviders(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <Suspense fallback={<div>Loading...</div>}>{ui}</Suspense>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Budget', () => {
  it('renders global spend stats and per-model breakdown', async () => {
    renderWithProviders(<Budget />);
    await waitFor(() => {
      expect(screen.getByText('Daily Spend')).toBeInTheDocument();
      expect(screen.getByText('$5.12')).toBeInTheDocument();
      expect(screen.getByText('$100.00')).toBeInTheDocument();
      expect(screen.getByText('$50.55')).toBeInTheDocument();
      expect(screen.getByText('gpt-4o')).toBeInTheDocument();
      expect(screen.getByText('$30.2500')).toBeInTheDocument();
      expect(screen.getByText('$20.00')).toBeInTheDocument();
    });
    expect(screen.getAllByText('unlimited')).toHaveLength(2);
  });

  it('shows usage percentages against configured limits', async () => {
    renderWithProviders(<Budget />);
    await waitFor(() => {
      expect(screen.getByText('Usage')).toBeInTheDocument();
      expect(screen.getAllByText('5%')).toHaveLength(2);
    });
  });
});
