import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { Scenarios } from '../../src/pages/Scenarios';

vi.mock('echarts-for-react', () => ({ default: () => <div data-testid="echarts-mock" /> }));

vi.mock('../../src/lib/api', async () => {
  const actual = await vi.importActual('../../src/lib/api');
  return {
    ...actual,
    listScenarios: vi.fn().mockResolvedValue([
      { name: 'express-rest', description: 'Build an Express REST API', systemPrompt: 'You are a developer', task: 'Build API' },
      { name: 'cli-tool', description: 'Build a CLI tool', systemPrompt: 'You are a CLI developer', task: 'Build CLI' },
    ]),
    getScenario: vi.fn(),
    deleteScenario: vi.fn(),
  };
});

function renderWithProviders(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter>{ui}</MemoryRouter></QueryClientProvider>);
}

describe('Scenarios', () => {
  it('renders the scenarios heading', () => {
    renderWithProviders(<Scenarios />);
    expect(screen.getByText(/Scenarios/i)).toBeInTheDocument();
  });

  it('renders the add scenario button', () => {
    renderWithProviders(<Scenarios />);
    expect(screen.getByRole('button', { name: /New scenario/i })).toBeInTheDocument();
  });
});
