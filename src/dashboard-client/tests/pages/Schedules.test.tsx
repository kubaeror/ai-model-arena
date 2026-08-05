import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { Suspense } from 'react';
import { Schedules } from '../../src/pages/Schedules';

vi.mock('echarts-for-react', () => ({ default: () => <div data-testid="echarts-mock" /> }));

const { schedules, updateScheduleMock } = vi.hoisted(() => ({
  schedules: [
    { id: 's1', scenario: 'express-rest', models: ['gpt-4o'], cron: '0 3 * * *', enabled: true, state: null },
    { id: 's2', scenario: 'cli-tool', models: ['claude-3.7'], cron: '0 6 * * *', enabled: false, state: null },
  ],
  updateScheduleMock: vi.fn(),
}));

vi.mock('../../src/lib/api', async () => {
  const actual = await vi.importActual('../../src/lib/api');
  return {
    ...actual,
    listSchedules: vi.fn().mockResolvedValue(schedules),
    listScenarios: vi.fn().mockResolvedValue([]),
    listModels: vi.fn().mockResolvedValue([]),
    createSchedule: vi.fn(),
    deleteSchedule: vi.fn(),
    updateSchedule: updateScheduleMock,
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

describe('Schedules', () => {
  it('renders schedule rows', async () => {
    renderWithProviders(<Schedules />);
    await waitFor(() => {
      expect(screen.getByText(/express-rest/)).toBeInTheDocument();
      expect(screen.getByText(/cli-tool/)).toBeInTheDocument();
    });
  });

  it('calls updateSchedule when a row toggle is flipped', async () => {
    renderWithProviders(<Schedules />);
    const checkboxes = await screen.findAllByRole('checkbox');
    expect(checkboxes).toHaveLength(2);

    fireEvent.click(checkboxes[0]);
    await waitFor(() => {
      expect(updateScheduleMock).toHaveBeenCalledWith('s1', { enabled: false });
    });
  });
});
