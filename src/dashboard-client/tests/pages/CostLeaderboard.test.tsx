import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { Suspense } from 'react';
import { CostLeaderboard } from '../../src/pages/CostLeaderboard';

const { leaderboard, costLeaderboardMock } = vi.hoisted(() => {
  const leaderboard = [
    { model: 'gpt-4o', runs: 10, successes: 8, successRate: 0.8, totalCost: 1.2345, costPerSuccess: 0.1543, avgCostPerRun: 0.1234, totalTokens: 1234567 },
    { model: 'claude-3.7', runs: 4, successes: 4, successRate: 1, totalCost: 0.4321, costPerSuccess: 0.108, avgCostPerRun: 0.108, totalTokens: 543210 },
  ];
  return { leaderboard, costLeaderboardMock: vi.fn().mockResolvedValue(leaderboard) };
});

vi.mock('../../src/lib/api', async () => {
  const actual = await vi.importActual('../../src/lib/api');
  return { ...actual, getCostLeaderboard: costLeaderboardMock };
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

describe('CostLeaderboard', () => {
  beforeEach(() => {
    costLeaderboardMock.mockResolvedValue(leaderboard);
  });

  it('renders model rows with success rate and cost columns', async () => {
    renderWithProviders(<CostLeaderboard />);
    await waitFor(() => {
      expect(screen.getByText('gpt-4o')).toBeInTheDocument();
      expect(screen.getByText('claude-3.7')).toBeInTheDocument();
      expect(screen.getByText('80.0%')).toBeInTheDocument();
      expect(screen.getByText('$1.2345')).toBeInTheDocument();
      expect(screen.getByText('$0.1543')).toBeInTheDocument();
    });
    expect(screen.getByText('2 models')).toBeInTheDocument();
  });

  it('shows an empty state when there is no cost data', async () => {
    costLeaderboardMock.mockResolvedValue([]);
    renderWithProviders(<CostLeaderboard />);
    await waitFor(() => {
      expect(screen.getByText('No cost data')).toBeInTheDocument();
    });
  });
});
