import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import userEvent from '@testing-library/user-event';

vi.mock('echarts-for-react', () => ({ default: () => <div data-testid="echarts-mock" /> }));

// Mock the useAuth hook
vi.mock('../../src/hooks/useAuth', () => ({
  useAuth: () => ({
    isAuthenticated: true,
    token: 'test-token',
    username: 'admin',
    login: vi.fn(),
    logout: vi.fn(),
  }),
}));

vi.mock('../../src/hooks/useLive', () => ({
  useRunLive: () => ({
    entries: [],
    logLines: [],
    completed: false,
    online: false,
  }),
}));

vi.mock('../../src/lib/api', async () => {
  const actual = await vi.importActual('../../src/lib/api');
  return {
    ...actual,
    getRun: vi.fn().mockResolvedValue({
      run: {
        runId: 'test-run-1',
        scenario: 'express-rest',
        status: 'completed',
        perModel: [
          { model: 'gpt-4o', runId: 'test-run-1', status: 'completed', procName: 'p1', outputDir: '/o', sandboxDir: '/s', resultPath: '/r', conversationPath: '/c', reportPath: '/m', logFile: '/l' },
        ],
      },
    }),
    getConversation: vi.fn().mockResolvedValue({ entries: [] }),
    getRunFiles: vi.fn().mockResolvedValue([]),
    getRunLogs: vi.fn().mockResolvedValue([]),
  };
});

function renderWithProviders(ui: React.ReactElement, { route = '/' } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[route]}>
        <Routes>
          <Route path="/run/:runId" element={ui} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('RunDetail', () => {
  it('renders conversation tab by default', async () => {
    const { RunDetail } = await import('../../src/pages/RunDetail');
    renderWithProviders(<RunDetail />, { route: '/run/test-run-1' });
    // Shows loading initially, then renders after query resolves
    expect(screen.getByText(/conversation/i)).toBeInTheDocument();
  });
});
