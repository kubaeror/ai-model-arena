import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { Ops } from '../../src/pages/Ops';

vi.mock('../../src/hooks/useLive', () => ({
  useLive: () => ({
    processes: [
      { name: 'run1:alpha', runId: 'run1', model: 'alpha', scenario: 'basic', status: 'running', online: true },
      { name: 'run1:beta', runId: 'run1', model: 'beta', scenario: 'basic', status: 'completed', online: false },
    ],
    connected: true,
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    getRunState: vi.fn(),
  }),
}));

vi.mock('../../src/hooks/useCache', () => ({
  useCacheStats: () => ({ data: undefined, isLoading: true }),
  useRefreshCache: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('../../src/lib/api', () => ({
  getKillswitch: vi.fn().mockResolvedValue({ active: false }),
  activateKillswitch: vi.fn().mockResolvedValue({}),
  deactivateKillswitch: vi.fn().mockResolvedValue({}),
}));

function renderOps() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <Ops />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Ops', () => {
  it('renders the run status panel with process rows', async () => {
    renderOps();
    await waitFor(() => {
      expect(screen.getByText('Run Status')).toBeInTheDocument();
    });
    expect(screen.getByText('run1:alpha')).toBeInTheDocument();
    expect(screen.getByText('run1:beta')).toBeInTheDocument();
    expect(screen.getAllByText('run1')).toHaveLength(2);
  });

  it('renders no undefined% or undefinedMB cells when process_status has no cpu/memory', async () => {
    renderOps();
    await waitFor(() => {
      expect(screen.getByText('Run Status')).toBeInTheDocument();
    });
    expect(screen.queryByText(/undefined%|undefinedMB/)).not.toBeInTheDocument();
    expect(screen.queryByText('CPU')).not.toBeInTheDocument();
    expect(screen.queryByText('Mem')).not.toBeInTheDocument();
  });
});
