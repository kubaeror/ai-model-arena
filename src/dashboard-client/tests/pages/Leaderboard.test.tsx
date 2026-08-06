import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { Suspense } from 'react';
import { Leaderboard } from '../../src/pages/Leaderboard';

const { leaderboardData, apiFetchMock } = vi.hoisted(() => {
  const leaderboardData = [
    { id: 'gpt-4o', name: 'GPT-4o', provider_id: 'openai', context_limit: 128000, input: 2.5, output: 10, cache_read: 1.25, intelligence: 9.1, coding: 8.7, arena_tps: 50.4, arena_latency: 320, arena_runs: 5 },
    { id: 'claude-3-7-sonnet', name: 'Claude 3.7 Sonnet', provider_id: 'anthropic', context_limit: 200000, input: 3, output: 15, cache_read: 1.5, intelligence: 8.8, coding: 9.2, arena_tps: 41.2, arena_latency: 410, arena_runs: 0 },
    { id: 'gemini-2-5-pro', name: 'Gemini 2.5 Pro', provider_id: 'google', context_limit: 1000000, input: 1.25, output: 10, cache_read: 0.1, intelligence: 8.5, coding: 8.1, arena_tps: 60.1, arena_latency: 280, arena_runs: 3 },
  ];
  return {
    leaderboardData,
    apiFetchMock: vi.fn().mockImplementation(async (path: string) => {
      if (path.startsWith('/api/cache/leaderboard')) {
        return { data: leaderboardData };
      }
      throw new Error(`unexpected GET ${path}`);
    }),
  };
});

vi.mock('../../src/lib/api', async () => {
  const actual = await vi.importActual('../../src/lib/api');
  return { ...actual, apiFetch: apiFetchMock };
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

describe('Leaderboard', () => {
  it('renders model rows with pricing and arena stats', async () => {
    renderWithProviders(<Leaderboard />);
    await waitFor(() => {
      expect(screen.getByText('GPT-4o')).toBeInTheDocument();
      expect(screen.getByText('Claude 3.7 Sonnet')).toBeInTheDocument();
      expect(screen.getByText('Gemini 2.5 Pro')).toBeInTheDocument();
      expect(screen.getByText('9.1')).toBeInTheDocument();
      expect(screen.getByText('320ms')).toBeInTheDocument();
    });
    expect(screen.getByText('3 models')).toBeInTheDocument();
  });

  it('filters to arena-only models when the toggle is clicked', async () => {
    renderWithProviders(<Leaderboard />);
    await waitFor(() => {
      expect(screen.getByText('3 models')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /Arena data only/ }));

    await waitFor(() => {
      expect(screen.getByText('2 models')).toBeInTheDocument();
    });
    expect(screen.queryByText('Claude 3.7 Sonnet')).not.toBeInTheDocument();
    expect(screen.getByText('GPT-4o')).toBeInTheDocument();
  });
});
