import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router';
import { Suspense } from 'react';
import { Sessions } from '../../src/pages/Sessions';
import { SessionDetail } from '../../src/pages/SessionDetail';
import { Files } from '../../src/pages/Files';
import { Audit } from '../../src/pages/Audit';
import {
  getSession,
  getSessionMessages,
  getSessionCalls,
  listSessions,
  listFiles,
  listAudit,
} from '../../src/lib/api';

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
  const result = render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={initialEntries}>
        <Suspense fallback={<div>Loading...</div>}>{ui}</Suspense>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { qc, ...result };
}

function listRow(id: string) {
  return {
    id,
    prompt_id: null,
    prompt_version: null,
    model: 'gpt-4o',
    status: 'active',
    created_at: '2026-08-04T00:00:00.000Z',
    updated_at: '2026-08-04T00:00:00.000Z',
    message_count: 1,
    call_count: 1,
  };
}

function sessionsPage(from: number, count: number) {
  return Array.from({ length: count }, (_, i) => listRow(`s${from + i}`));
}

describe('Sessions', () => {
  it('renders the sessions heading and a session row', async () => {
    renderWithProviders(<Sessions />);
    await waitFor(() => {
      expect(screen.getAllByText(/Sessions/i).length).toBeGreaterThan(0);
      expect(screen.getByText(/gpt-4o/)).toBeInTheDocument();
    });
  });

  it('appends the next page instead of replacing rows when Load more is clicked', async () => {
    vi.mocked(listSessions).mockReset();
    vi.mocked(listSessions)
      .mockResolvedValueOnce({ sessions: [listRow('sess-A')], total: 2 })
      .mockResolvedValueOnce({ sessions: [listRow('sess-B')], total: 2 });

    renderWithProviders(<Sessions />);
    expect(await screen.findByText(/sess-A/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /load more/i }));

    // Offset follows the loaded (deduped) row count, not the page index.
    await waitFor(() => {
      expect(listSessions).toHaveBeenCalledWith({ limit: 50, offset: 1 });
    });
    expect(await screen.findByText(/sess-B/)).toBeInTheDocument();
    expect(screen.getByText(/sess-A/)).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /load more/i })).not.toBeInTheDocument();
    });
  });

  it('dedupes rows and skips nothing when a refetch sees rows inserted at the top', async () => {
    vi.mocked(listSessions).mockReset();
    vi.mocked(listSessions)
      // initial load tiles s1..s100 in two full pages
      .mockResolvedValueOnce({ sessions: sessionsPage(1, 50), total: 101 })
      .mockResolvedValueOnce({ sessions: sessionsPage(51, 50), total: 101 })
      // refetch: n1 was inserted at the top before page 0 loaded
      .mockResolvedValueOnce({ sessions: [listRow('n1'), ...sessionsPage(1, 49)], total: 102 })
      // another insert between refetches shifts page 1 onto s49..s98 (overlaps page 0)
      .mockResolvedValueOnce({ sessions: sessionsPage(49, 50), total: 103 })
      // next page requested from the deduped loaded count (99), not page index * size (100)
      .mockResolvedValueOnce({ sessions: sessionsPage(98, 4), total: 103 });

    const { qc } = renderWithProviders(<Sessions />);
    expect(await screen.findByText('s1…')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /load more/i }));
    await waitFor(() => expect(listSessions).toHaveBeenCalledWith({ limit: 50, offset: 50 }));
    expect(await screen.findByText('s100…')).toBeInTheDocument();

    await act(async () => {
      await qc.refetchQueries({ queryKey: ['sessions'] });
    });
    expect(await screen.findByText('n1…')).toBeInTheDocument();

    // No row id renders twice and the shifted window does not drop s49/s50.
    const renderedIds = screen.getAllByRole('row').slice(1).map((tr) => tr.querySelector('td')?.textContent);
    const expectedIds = ['n1', ...Array.from({ length: 98 }, (_, i) => `s${i + 1}`)].map((id) => `${id}…`);
    expect(renderedIds).toEqual(expectedIds);

    fireEvent.click(screen.getByRole('button', { name: /load more/i }));
    await waitFor(() => expect(listSessions).toHaveBeenNthCalledWith(5, { limit: 50, offset: 99 }));
  });

  it('stops the 15s refetch interval once more than one page is loaded', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      vi.mocked(listSessions).mockReset();
      vi.mocked(listSessions).mockImplementation(async (params?: { offset?: number }) => (
        (params?.offset ?? 0) === 0
          ? { sessions: [listRow('sess-A')], total: 2 }
          : { sessions: [listRow('sess-B')], total: 2 }
      ));

      renderWithProviders(<Sessions />);
      expect(await screen.findByText(/sess-A/)).toBeInTheDocument();

      // Single page: the interval keeps the first page fresh.
      const callsBefore = vi.mocked(listSessions).mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000);
      });
      expect(vi.mocked(listSessions).mock.calls.length).toBeGreaterThan(callsBefore);

      fireEvent.click(screen.getByRole('button', { name: /load more/i }));
      expect(await screen.findByText(/sess-B/)).toBeInTheDocument();

      // Two pages loaded: the interval must not refetch every loaded page.
      const callsAfterPaging = vi.mocked(listSessions).mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(vi.mocked(listSessions).mock.calls.length).toBe(callsAfterPaging);
    } finally {
      vi.useRealTimers();
    }
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

  it('appends the next page instead of replacing files when Load more is clicked', async () => {
    const row = (id: number, path: string) => ({
      id,
      run_id: 'run-1',
      prompt_id: null,
      model: 'gpt-4o',
      produced_at: '2026-08-04T00:00:00.000Z',
      produced_by_tool: 'write_file',
      path,
    });
    vi.mocked(listFiles).mockReset();
    vi.mocked(listFiles)
      .mockResolvedValueOnce({ files: [row(1, 'src/first.ts')], total: 2 })
      .mockResolvedValueOnce({ files: [row(2, 'src/second.ts')], total: 2 });

    renderWithProviders(<Files />);
    expect(await screen.findByText('src/first.ts')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /load more/i }));

    await waitFor(() => {
      expect(listFiles).toHaveBeenCalledWith({ limit: 50, offset: 1 });
    });
    expect(await screen.findByText('src/second.ts')).toBeInTheDocument();
    expect(screen.getByText('src/first.ts')).toBeInTheDocument();
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

  it('appends the next page instead of replacing entries when Load more is clicked', async () => {
    const row = (id: number, actor: string) => ({
      id,
      actor,
      action: 'user.delete',
      entity_type: 'user',
      entity_id: `u${id}`,
      at: '2026-08-04T00:00:00.000Z',
      before: null,
      after: null,
    });
    vi.mocked(listAudit).mockReset();
    vi.mocked(listAudit)
      .mockResolvedValueOnce({ entries: [row(1, 'alice')], total: 2 })
      .mockResolvedValueOnce({ entries: [row(2, 'bob')], total: 2 });

    renderWithProviders(<Audit />);
    expect(await screen.findByText('alice')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /load more/i }));

    await waitFor(() => {
      expect(listAudit).toHaveBeenCalledWith({ actor: undefined, action: undefined, limit: 50, offset: 1 });
    });
    expect(await screen.findByText('bob')).toBeInTheDocument();
    expect(screen.getByText('alice')).toBeInTheDocument();
  });
});
