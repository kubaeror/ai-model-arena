import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { Suspense } from 'react';
import { Sessions } from '../../src/pages/Sessions';
import { SessionDetail } from '../../src/pages/SessionDetail';
import { Files } from '../../src/pages/Files';
import { Audit } from '../../src/pages/Audit';

vi.mock('echarts-for-react', () => ({ default: () => <div data-testid="echarts-mock" /> }));

vi.mock('../../src/lib/api', async () => {
  const actual = await vi.importActual('../../src/lib/api');
  return {
    ...actual,
    listSessions: vi.fn().mockResolvedValue({
      sessions: [{ id: 'sess-1', model: 'gpt-4o', status: 'active', message_count: 3, call_count: 2, created_at: '2026-08-04T00:00:00.000Z' }],
      total: 1,
    }),
    getSession: vi.fn().mockResolvedValue({ id: 'sess-1', model: 'gpt-4o', status: 'active', message_count: 3, call_count: 2, created_at: '2026-08-04T00:00:00.000Z' }),
    getSessionMessages: vi.fn().mockResolvedValue([{ id: 'm1', role: 'user', turn: 0, content: 'hi' }]),
    getSessionCalls: vi.fn().mockResolvedValue([]),
    deleteSession: vi.fn(),
    listFiles: vi.fn().mockResolvedValue({
      files: [{ id: 1, run_id: 'run-1', model: 'gpt-4o', path: 'src/app.ts', produced_by_tool: 'write_file', produced_at: '2026-08-04T00:00:00.000Z' }],
      total: 1,
    }),
    listAudit: vi.fn().mockResolvedValue({
      entries: [{ id: 1, actor: 'admin', action: 'user.delete', entity_type: 'user', entity_id: 'u1', at: '2026-08-04T00:00:00.000Z', before: null, after: null }],
      total: 1,
    }),
  };
});

function renderWithProviders(ui: React.ReactElement, initialEntries?: string[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={initialEntries}>
        <Suspense fallback={<div>Loading...</div>}>{ui}</Suspense>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Sessions', () => {
  it('renders the sessions heading and a session row', async () => {
    renderWithProviders(<Sessions />);
    await waitFor(() => {
      expect(screen.getAllByText(/Sessions/i).length).toBeGreaterThan(0);
      expect(screen.getByText(/gpt-4o/)).toBeInTheDocument();
    });
  });
});

describe('SessionDetail', () => {
  it('renders session info and messages', async () => {
    renderWithProviders(<SessionDetail />, ['/sessions/sess-1']);
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: /Messages/i })).toBeInTheDocument();
      expect(screen.getByText(/user/)).toBeInTheDocument();
    });
  });
});

describe('Files', () => {
  it('renders the files heading and a produced file', async () => {
    renderWithProviders(<Files />);
    await waitFor(() => {
      expect(screen.getAllByText(/Files/i).length).toBeGreaterThan(0);
      expect(screen.getByText(/src\/app.ts/)).toBeInTheDocument();
    });
  });
});

describe('Audit', () => {
  it('renders the audit heading and an entry', async () => {
    renderWithProviders(<Audit />);
    await waitFor(() => {
      expect(screen.getByText(/Audit Log/i)).toBeInTheDocument();
      expect(screen.getByText(/user.delete/)).toBeInTheDocument();
    });
  });
});
