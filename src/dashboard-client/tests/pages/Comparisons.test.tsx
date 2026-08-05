import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { Suspense } from 'react';
import { Comparisons } from '../../src/pages/Comparisons';

const { runs, listRunsMock } = vi.hoisted(() => {
  const runs = [
    {
      runId: 'run-1',
      scenario: 'express-rest',
      models: ['gpt-4o', 'claude-3.7'],
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:05:00.000Z',
      status: 'completed',
      source: 'dashboard',
      perModel: [
        { model: 'gpt-4o', runId: 'run-1', status: 'completed', outputDir: '/o', sandboxDir: '/s', resultPath: '/r', conversationPath: '/c', reportPath: '/m', logFile: '/l', success: true, turnsUsed: 3, totalToolCalls: 5, durationMs: 1500, stopReason: 'completed' },
        { model: 'claude-3.7', runId: 'run-1', status: 'failed', outputDir: '/o', sandboxDir: '/s', resultPath: '/r', conversationPath: '/c', reportPath: '/m', logFile: '/l', success: false, turnsUsed: 1, totalToolCalls: 0, durationMs: 200, stopReason: 'error' },
      ],
      comparisonMdPath: null,
      comparisonJsonPath: null,
    },
  ];
  return { runs, listRunsMock: vi.fn().mockResolvedValue(runs) };
});

vi.mock('../../src/lib/api', async () => {
  const actual = await vi.importActual('../../src/lib/api');
  return { ...actual, listRuns: listRunsMock };
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

describe('Comparisons', () => {
  it('renders runs grouped by scenario with per-model results', async () => {
    renderWithProviders(<Comparisons />);
    await waitFor(() => {
      expect(screen.getByText('express-rest')).toBeInTheDocument();
      expect(screen.getByText('run-1')).toBeInTheDocument();
      expect(screen.getByText('gpt-4o')).toBeInTheDocument();
      expect(screen.getByText('claude-3.7')).toBeInTheDocument();
      expect(screen.getByText('PASS')).toBeInTheDocument();
      expect(screen.getByText('FAIL')).toBeInTheDocument();
      expect(screen.getByText('1.5s')).toBeInTheDocument();
    });
  });

  it('shows an empty state when there are no runs', async () => {
    listRunsMock.mockResolvedValue([]);
    renderWithProviders(<Comparisons />);
    await waitFor(() => {
      expect(screen.getByText('No runs yet')).toBeInTheDocument();
    });
  });
});
