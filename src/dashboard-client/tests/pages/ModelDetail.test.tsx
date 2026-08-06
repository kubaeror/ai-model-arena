import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import { Suspense } from 'react';
import { ModelDetail } from '../../src/pages/ModelDetail';

vi.mock('echarts-for-react', () => ({ default: () => <div data-testid="echarts-mock" /> }));

const { modelDetail, apiFetchMock } = vi.hoisted(() => {
  const modelDetail = {
    model: {
      id: 'gpt-4o',
      name: 'GPT-4o',
      family: 'gpt',
      provider_id: 'openai',
      attachment: 1,
      reasoning: 1,
      temperature: 0,
      tool_call: 1,
      context_limit: 128000,
      output_limit: 16384,
      status: 'production',
      reasoning_options: null,
      input: 2.5,
      output: 10,
      cache_read: 1.25,
      cache_write: 5,
    },
    benchmarks: [
      { model_id: 'gpt-4o', benchmark: 'SWE-bench', source: 'paper', score: 42.3, measured_at: '2026-01-01T00:00:00.000Z', source_url: null, is_preferred: 1 },
    ],
    runtime: [
      { run_id: 'r1', latency_p50_ms: 100, latency_p95_ms: 220, tps: 55, ttft_ms: 5, cache_hit_rate: 0.5, cost_usd: 0.1, success: 1, measured_at: '2026-01-01T00:00:00.000Z' },
    ],
  };
  return {
    modelDetail,
    apiFetchMock: vi.fn().mockImplementation(async (path: string) => {
      if (path.startsWith('/api/catalog/models/')) {
        return modelDetail;
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
      <MemoryRouter initialEntries={['/models/gpt-4o']}>
        <Routes>
          <Route path="/models/:id" element={<Suspense fallback={<div>Loading...</div>}>{ui}</Suspense>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ModelDetail', () => {
  it('renders model header, pricing stats, and capabilities', async () => {
    renderWithProviders(<ModelDetail />);
    await waitFor(() => {
      expect(screen.getAllByText('GPT-4o').length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText('openai')).toBeInTheDocument();
      expect(screen.getByText('128,000')).toBeInTheDocument();
      expect(screen.getByText('$2.5')).toBeInTheDocument();
      expect(screen.getByText('Capabilities')).toBeInTheDocument();
    });
    expect(screen.getByText('gpt')).toBeInTheDocument();
  });

  it('shows benchmark scores on the Benchmarks tab', async () => {
    renderWithProviders(<ModelDetail />);
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'Benchmarks' })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('tab', { name: 'Benchmarks' }));
    await waitFor(() => {
      expect(screen.getByText('SWE-bench')).toBeInTheDocument();
      expect(screen.getByText('42.3')).toBeInTheDocument();
      expect(screen.getByText(/paper/)).toBeInTheDocument();
    });
  });

  it('shows arena metric charts on the metrics tab', async () => {
    renderWithProviders(<ModelDetail />);
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'Arena metrics' })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('tab', { name: 'Arena metrics' }));
    await waitFor(() => {
      expect(screen.getByText('Latency over time')).toBeInTheDocument();
      expect(screen.getByText('TPS over time')).toBeInTheDocument();
    });
  });
});
