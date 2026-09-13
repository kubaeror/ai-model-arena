import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router';
import { Suspense } from 'react';
import { Sessions } from '../../src/pages/Sessions';
import { SessionDetail } from '../../src/pages/SessionDetail';
import { Files } from '../../src/pages/Files';
import { Audit } from '../../src/pages/Audit';
import { getSession, getSessionMessages, getSessionCalls } from '../../src/lib/api';

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

const PAGE_SIZE = 200;

function sessionRow(messageCount: number, callCount: number) {
  return {
    id: 'sess-1',
    prompt_id: null,
    prompt_version: null,
    model: 'gpt-4o',
    status: 'active',
    created_at: '2026-08-04T00:00:00.000Z',
    updated_at: '2026-08-04T00:00:00.000Z',
    message_count: messageCount,
    call_count: callCount,
  };
}

function messagesPage(offset: number, count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `m${offset + i}`,
    role: i % 2 === 0 ? 'user' : 'assistant',
    turn: offset + i,
    content: `message ${offset + i}`,
  }));
}

function callsPage(offset: number, count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `c${offset + i}`,
    turn: offset + i,
    provider: 'openai',
    model: 'gpt-4o',
    latency_ms: offset + i,
    response_text: `call ${offset + i}`,
  }));
}

function renderSessionDetail() {
  return renderWithProviders(
    <Routes>
      <Route path="/sessions/:sessionId" element={<SessionDetail />} />
    </Routes>,
    ['/sessions/sess-1'],
  );
}

describe('SessionDetail', () => {
  it('renders session info and messages', async () => {
    renderWithProviders(<SessionDetail />, ['/sessions/sess-1']);
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: /Messages/i })).toBeInTheDocument();
      expect(screen.getByText(/user/)).toBeInTheDocument();
    });
  });

  it('loads later message pages by offset, appends without duplicates, and hides the control when complete', async () => {
    vi.mocked(getSession).mockResolvedValue(sessionRow(202, 0));
    vi.mocked(getSessionMessages).mockReset();
    vi.mocked(getSessionMessages)
      .mockResolvedValueOnce(messagesPage(0, PAGE_SIZE))
      .mockResolvedValueOnce([
        { id: 'm199', role: 'assistant', turn: 199, content: 'message 199' },
        { id: 'm200', role: 'assistant', turn: 200, content: 'message 200' },
        { id: 'm201', role: 'user', turn: 201, content: 'message 201' },
      ]);

    renderSessionDetail();

    await waitFor(() => expect(getSessionMessages).toHaveBeenCalledWith('sess-1', { limit: 200 }));
    expect(await screen.findByText('message 0')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /load more/i }));

    await waitFor(() => expect(getSessionMessages).toHaveBeenCalledWith('sess-1', { limit: 200, offset: 200 }));
    expect(await screen.findByText('message 201')).toBeInTheDocument();
    expect(screen.getByText('message 200')).toBeInTheDocument();
    expect(screen.getAllByText('message 0')).toHaveLength(1);
    expect(screen.getAllByText('message 199')).toHaveLength(1);
    expect(screen.getAllByText('message 200')).toHaveLength(1);

    await waitFor(() => expect(screen.queryByRole('button', { name: /load more/i })).not.toBeInTheDocument());
    const limits = vi.mocked(getSessionMessages).mock.calls.map(([, params]) => params?.limit);
    expect(limits).toEqual([200, 200]);
  });

  it('keeps accumulated rows visible with a per-control pending state while the next page loads', async () => {
    let resolvePage2!: (rows: Array<Record<string, unknown>>) => void;
    const pendingPage2 = new Promise<Array<Record<string, unknown>>>((resolve) => {
      resolvePage2 = resolve;
    });

    vi.mocked(getSession).mockResolvedValue(sessionRow(3, 0));
    vi.mocked(getSessionMessages).mockReset();
    vi.mocked(getSessionMessages)
      .mockResolvedValueOnce([{ id: 'm1', role: 'user', turn: 0, content: 'first message' }])
      .mockReturnValueOnce(pendingPage2);

    renderSessionDetail();
    expect(await screen.findByText('first message')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /load more/i }));

    await waitFor(() => expect(getSessionMessages).toHaveBeenCalledWith('sess-1', { limit: 200, offset: 1 }));
    expect(screen.getByText('first message')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /loading/i })).toBeDisabled();

    resolvePage2([{ id: 'm2', role: 'assistant', turn: 1, content: 'second message' }]);
    expect(await screen.findByText('second message')).toBeInTheDocument();
    expect(screen.getByText('first message')).toBeInTheDocument();
  });

  it('loads later call pages by offset and hides the control when complete', async () => {
    vi.mocked(getSession).mockResolvedValue(sessionRow(0, 202));
    vi.mocked(getSessionMessages).mockReset().mockResolvedValue([]);
    vi.mocked(getSessionCalls).mockReset();
    vi.mocked(getSessionCalls)
      .mockResolvedValueOnce(callsPage(0, PAGE_SIZE))
      .mockResolvedValueOnce([
        { id: 'c200', turn: 200, provider: 'openai', model: 'gpt-4o', latency_ms: 200, response_text: 'call 200' },
        { id: 'c201', turn: 201, provider: 'openai', model: 'gpt-4o', latency_ms: 201, response_text: 'call 201' },
      ]);

    renderSessionDetail();

    fireEvent.click(await screen.findByRole('tab', { name: /llm calls/i }));
    await waitFor(() => expect(getSessionCalls).toHaveBeenCalledWith('sess-1', { limit: 200 }));
    expect(await screen.findByText('call 0')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /load more/i }));

    await waitFor(() => expect(getSessionCalls).toHaveBeenCalledWith('sess-1', { limit: 200, offset: 200 }));
    expect(await screen.findByText('call 201')).toBeInTheDocument();
    expect(screen.getByText('call 0')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('button', { name: /load more/i })).not.toBeInTheDocument());
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
