import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { Home } from '../../src/pages/Home';

vi.mock('echarts-for-react', () => ({
  default: () => <div data-testid="echarts-mock" />,
}));

function renderWithProviders(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Home', () => {
  it('renders the mission control heading', () => {
    renderWithProviders(<Home />);
    expect(screen.getByText(/Mission Control/i)).toBeInTheDocument();
  });

  it('renders the token flow sankey panel', () => {
    renderWithProviders(<Home />);
    expect(screen.getAllByText(/Token Flow/i).length).toBeGreaterThanOrEqual(1);
  });

  it('renders the launcher button', () => {
    renderWithProviders(<Home />);
    expect(screen.getByRole('button', { name: /Run/i })).toBeInTheDocument();
  });
});
