import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { Suspense } from 'react';
import { Scenarios } from '../../src/pages/Scenarios';
import * as api from '../../src/lib/api';

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
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <Suspense fallback={<div>Loading...</div>}>{ui}</Suspense>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Scenarios', () => {
  it('renders the scenarios heading', async () => {
    renderWithProviders(<Scenarios />);
    await waitFor(() => {
      expect(screen.getByText(/Scenarios/i)).toBeInTheDocument();
    });
  });

  it('renders the add scenario button', async () => {
    renderWithProviders(<Scenarios />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /New scenario/i })).toBeInTheDocument();
    });
  });

  it('surfaces scenario delete failures', async () => {
    vi.mocked(api.deleteScenario).mockRejectedValueOnce(new Error('delete exploded'));
    renderWithProviders(<Scenarios />);
    await waitFor(() => {
      expect(screen.getByText('express-rest')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Delete express-rest' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('delete exploded');
  });
});
