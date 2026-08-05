import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { Suspense } from 'react';
import { Regression } from '../../src/pages/Regression';

vi.mock('echarts-for-react', () => ({ default: () => <div data-testid="echarts-mock" /> }));

const { pastResults, runRegressionMock } = vi.hoisted(() => ({
  pastResults: [
    {
      suite: 'suite-a',
      runId: 'regress-1',
      model: 'gpt-4o',
      passed: true,
      timestamp: '2026-01-03T00:00:00.000Z',
      scenarioResults: [
        { scenario: 's1', success: true, current: { model: 'gpt-4o', scenario: 's1', success: true, durationMs: 1000, turnsUsed: 2 } },
      ],
    },
    {
      suite: 'suite-b',
      runId: 'regress-2',
      model: 'claude-3.7',
      passed: false,
      timestamp: '2026-01-02T00:00:00.000Z',
      scenarioResults: [
        {
          scenario: 's2', success: true,
          regression: { passed: false, regressions: [{ metric: 'averageScore', baseline: 8, current: 6, change: 2, threshold: 1 }] },
          current: { model: 'claude-3.7', scenario: 's2', success: true, durationMs: 2000, turnsUsed: 3 },
        },
      ],
    },
  ],
  runRegressionMock: vi.fn(),
}));

vi.mock('../../src/lib/api', async () => {
  const actual = await vi.importActual('../../src/lib/api');
  return {
    ...actual,
    listRegressionSuites: vi.fn().mockResolvedValue(['suite-a', 'suite-b']),
    runRegression: runRegressionMock,
    listRegressionResults: vi.fn().mockResolvedValue(pastResults),
  };
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

describe('Regression', () => {
  it('renders past saved results with status badges', async () => {
    renderWithProviders(<Regression />);
    await waitFor(() => {
      expect(screen.getAllByText(/suite-a/).length).toBeGreaterThanOrEqual(2);
      expect(screen.getAllByText(/suite-b/).length).toBeGreaterThanOrEqual(2);
      expect(screen.getByText(/regress-1/)).toBeInTheDocument();
      expect(screen.getByText(/regress-2/)).toBeInTheDocument();
      expect(screen.getByText(/PASSED/)).toBeInTheDocument();
      expect(screen.getByText(/FAILED/)).toBeInTheDocument();
    });
  });

  it('shows the number of failed regressions per result', async () => {
    renderWithProviders(<Regression />);
    await waitFor(() => {
      expect(screen.getByText(/Past results/)).toBeInTheDocument();
      expect(screen.getByText(/regress-2/)).toBeInTheDocument();
    });
  });
});
