import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { Suspense } from 'react';
import { Compare } from '../../src/pages/Compare';

const { models, benchmarks, apiGetMock } = vi.hoisted(() => {
  const models = [
    { id: 'gpt-4o', name: 'GPT-4o', family: 'gpt', provider_id: 'openai', attachment: 1, reasoning: 1, temperature: 0, tool_call: 1, context_limit: 128000, output_limit: 16384, status: null, reasoning_options: null, input: 2.5, output: 10, cache_read: 1.25, cache_write: 5 },
    { id: 'claude-3-7-sonnet', name: 'Claude 3.7 Sonnet', family: 'claude', provider_id: 'anthropic', attachment: 1, reasoning: 1, temperature: 0, tool_call: 1, context_limit: 200000, output_limit: 64000, status: null, reasoning_options: null, input: 3, output: 15, cache_read: 1.5, cache_write: 7.5 },
  ];
  const benchmarks = [
    { model_id: 'gpt-4o', benchmark: 'SWE-bench', source: 'paper', score: 42.3, measured_at: '2026-01-01T00:00:00.000Z', source_url: null, is_preferred: 1 },
    { model_id: 'claude-3-7-sonnet', benchmark: 'SWE-bench', source: 'paper', score: 55.1, measured_at: '2026-01-01T00:00:00.000Z', source_url: null, is_preferred: 1 },
  ];
  return {
    models,
    benchmarks,
    apiGetMock: vi.fn().mockImplementation(async (path: string) => {
      if (path.startsWith('/api/catalog/models')) return { ok: true, json: async () => ({ data: models }) };
      if (path.startsWith('/api/catalog/benchmarks')) return { ok: true, json: async () => ({ data: benchmarks }) };
      throw new Error(`unexpected GET ${path}`);
    }),
  };
});

vi.mock('../../src/lib/api', async () => {
  const actual = await vi.importActual('../../src/lib/api');
  return { ...actual, api: { ...actual.api, get: apiGetMock } };
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

describe('Compare', () => {
  it('shows an empty state until 2+ models are picked', async () => {
    renderWithProviders(<Compare />);
    await waitFor(() => {
      expect(screen.getByText(/Pick 2-4 models to compare/)).toBeInTheDocument();
    });
    expect(screen.getAllByRole('combobox')).toHaveLength(4);
  });

  it('renders side-by-side columns once two models are selected', async () => {
    renderWithProviders(<Compare />);
    await waitFor(() => {
      expect(screen.getAllByRole('option', { name: 'GPT-4o' }).length).toBeGreaterThanOrEqual(1);
    });

    const selects = screen.getAllByRole('combobox');
    fireEvent.change(selects[0], { target: { value: 'gpt-4o' } });
    fireEvent.change(selects[1], { target: { value: 'claude-3-7-sonnet' } });

    await waitFor(() => {
      expect(screen.getByText('128,000')).toBeInTheDocument();
      expect(screen.getByText('200,000')).toBeInTheDocument();
      expect(screen.getAllByText('$2.5').length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText('$3').length).toBeGreaterThanOrEqual(1);
    });
    expect(screen.getAllByText('SWE-bench').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('42.3')).toBeInTheDocument();
    expect(screen.getByText('55.1')).toBeInTheDocument();
  });
});
