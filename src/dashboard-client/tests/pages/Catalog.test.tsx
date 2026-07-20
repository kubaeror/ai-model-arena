import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { Catalog } from '../../src/pages/Catalog';

vi.mock('echarts-for-react', () => ({ default: () => <div data-testid="echarts-mock" /> }));

vi.mock('../../src/hooks/useCatalog', () => ({
  useCatalogModels: () => ({
    data: [
      { id: 'openai/gpt-4o', name: 'GPT-4o', provider_id: 'openai', reasoning: 0, tool_call: 1, context_limit: 128000, input: 2.5, output: 10, status: null },
      { id: 'anthropic/claude-3-7-sonnet', name: 'Claude 3.7 Sonnet', provider_id: 'anthropic', reasoning: 1, tool_call: 1, context_limit: 200000, input: 3, output: 15, status: 'beta' },
    ],
    isLoading: false,
  }),
}));

function renderWithProviders(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter>{ui}</MemoryRouter></QueryClientProvider>);
}

describe('Catalog', () => {
  it('renders the catalog heading', () => {
    renderWithProviders(<Catalog />);
    expect(screen.getByText(/Catalog/i)).toBeInTheDocument();
  });

  it('renders model rows from query', () => {
    renderWithProviders(<Catalog />);
    expect(screen.getByText('GPT-4o')).toBeInTheDocument();
    expect(screen.getByText('Claude 3.7 Sonnet')).toBeInTheDocument();
  });
});
