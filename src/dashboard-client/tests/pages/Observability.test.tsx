import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { Suspense } from 'react';
import { Observability } from '../../src/pages/Observability';

const { stats, traces, statsMock, tracesMock } = vi.hoisted(() => {
  const stats = {
    generatedAt: '2026-01-01T12:00:00.000Z',
    models: [
      { model: 'gpt-4o', runs: 5, errorRate: 0.2, anomalies: 1, unresolvedAnomalies: 1 },
      { model: 'claude-3.7', runs: 2, errorRate: 0, anomalies: 0, unresolvedAnomalies: 0 },
    ],
    latency: [
      { model: 'gpt-4o', tool: 'chat:openai', count: 10, avgMs: 100.5, p95Ms: 200.2, p99Ms: 300.3 },
    ],
  };
  const traces = [
    { runId: 'run-abc', model: 'gpt-4o', scenario: 'basic', spanCount: 12, errorCount: 0, totalDurationMs: 1500 },
  ];
  return {
    stats,
    traces,
    statsMock: vi.fn().mockResolvedValue(stats),
    tracesMock: vi.fn().mockResolvedValue(traces),
  };
});

vi.mock('../../src/lib/api', async () => {
  const actual = await vi.importActual('../../src/lib/api');
  return {
    ...actual,
    getObservabilityStats: statsMock,
    getRecentTraces: tracesMock,
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

describe('Observability', () => {
  beforeEach(() => {
    statsMock.mockResolvedValue(stats);
    tracesMock.mockResolvedValue(traces);
  });

  it('renders stat tiles and per-model stats from telemetry', async () => {
    renderWithProviders(<Observability />);
    await waitFor(() => {
      expect(screen.getByText('Total Runs')).toBeInTheDocument();
      expect(screen.getByText('7')).toBeInTheDocument();
      expect(screen.getAllByText('gpt-4o').length).toBeGreaterThanOrEqual(2);
      expect(screen.getByText('claude-3.7')).toBeInTheDocument();
      expect(screen.getByText('20.0%')).toBeInTheDocument();
    });
  });

  it('renders recent traces and latency breakdown rows', async () => {
    renderWithProviders(<Observability />);
    await waitFor(() => {
      expect(screen.getByText('basic')).toBeInTheDocument();
      expect(screen.getByText('1500ms')).toBeInTheDocument();
    });
    expect(screen.getByText('chat:openai')).toBeInTheDocument();
    expect(screen.getByText('100.5')).toBeInTheDocument();
    expect(screen.getByText('300.3')).toBeInTheDocument();
  });

  it('shows empty states when no telemetry data exists', async () => {
    statsMock.mockResolvedValue({ generatedAt: new Date().toISOString(), models: [], latency: [] });
    tracesMock.mockResolvedValue([]);
    renderWithProviders(<Observability />);
    await waitFor(() => {
      expect(screen.getByText('No model stats')).toBeInTheDocument();
      expect(screen.getByText('No traces')).toBeInTheDocument();
      expect(screen.getByText('No latency data')).toBeInTheDocument();
    });
  });
});
