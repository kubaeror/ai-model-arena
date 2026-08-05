import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { Suspense } from 'react';
import { Anomalies } from '../../src/pages/Anomalies';

const { anomalies, listAnomaliesMock, resolveAnomalyMock } = vi.hoisted(() => {
  const anomalies = [
    { id: 1, severity: 'high', type: 'latency', model: 'gpt-4o', run_id: 'run-123', description: 'P95 latency spiked above threshold', detected_at: '2026-01-01T00:00:00.000Z', resolved: false },
    { id: 2, severity: 'low', type: 'loop', model: 'claude-3.7', run_id: 'run-456', description: 'Repeated tool calls detected', detected_at: '2026-01-01T01:00:00.000Z', resolved: true, resolved_as: 'false_positive' },
  ];
  return {
    anomalies,
    listAnomaliesMock: vi.fn().mockResolvedValue(anomalies),
    resolveAnomalyMock: vi.fn().mockResolvedValue(anomalies[0]),
  };
});

vi.mock('../../src/lib/api', async () => {
  const actual = await vi.importActual('../../src/lib/api');
  return {
    ...actual,
    listAnomalies: listAnomaliesMock,
    resolveAnomaly: resolveAnomalyMock,
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

describe('Anomalies', () => {
  it('renders anomaly rows with severity, model, and state', async () => {
    renderWithProviders(<Anomalies />);
    await waitFor(() => {
      expect(screen.getAllByText('high').length).toBeGreaterThanOrEqual(2);
      expect(screen.getByText('gpt-4o')).toBeInTheDocument();
      expect(screen.getByText(/P95 latency spiked/)).toBeInTheDocument();
      expect(screen.getByText('run-456')).toBeInTheDocument();
      expect(screen.getByText('false_positive')).toBeInTheDocument();
    });
    expect(screen.getByText('open')).toBeInTheDocument();
  });

  it('resolves an anomaly via the Resolve button', async () => {
    renderWithProviders(<Anomalies />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Resolve' })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Resolve' }));
    await waitFor(() => {
      expect(resolveAnomalyMock).toHaveBeenCalledWith(1, 'resolved');
    });
  });

  it('marks an anomaly as a false positive', async () => {
    renderWithProviders(<Anomalies />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'False positive' })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: 'False positive' }));
    await waitFor(() => {
      expect(resolveAnomalyMock).toHaveBeenCalledWith(1, 'false_positive');
    });
  });
});
