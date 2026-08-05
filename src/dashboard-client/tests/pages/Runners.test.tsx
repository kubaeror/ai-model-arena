import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { Suspense } from 'react';
import { Runners } from '../../src/pages/Runners';

const { apiGetMock, apiPostMock, defaultGetImpl } = vi.hoisted(() => {
  const runners = [
    {
      name: 'runner-gpt-4o',
      provider: 'openai',
      replicas: 2,
      desiredReplicas: 2,
      status: 'ready',
      pods: [{ name: 'runner-gpt-4o-pod-1', status: 'running', node: 'node-a', startedAt: '2026-01-01T00:00:00.000Z' }],
    },
  ];
  const defaultGetImpl = async (path: string) => {
    if (path === '/api/runners') return { ok: true, json: async () => ({ runners }) };
    if (path === '/api/runners/runner-gpt-4o/logs') return { ok: true, text: async () => 'log line 1\nlog line 2' };
    throw new Error(`unexpected GET ${path}`);
  };
  return {
    apiGetMock: vi.fn(defaultGetImpl),
    apiPostMock: vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }),
    defaultGetImpl,
  };
});

vi.mock('../../src/lib/api', async () => {
  const actual = await vi.importActual('../../src/lib/api');
  return { ...actual, api: { ...actual.api, get: apiGetMock, post: apiPostMock } };
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

describe('Runners', () => {
  beforeEach(() => {
    apiGetMock.mockImplementation(defaultGetImpl);
  });

  it('renders runner deployments with pods', async () => {
    renderWithProviders(<Runners />);
    await waitFor(() => {
      expect(screen.getByText('runner-gpt-4o')).toBeInTheDocument();
      expect(screen.getByText(/openai/)).toBeInTheDocument();
      expect(screen.getByText(/2\/2 pods/)).toBeInTheDocument();
      expect(screen.getByText('runner-gpt-4o-pod-1')).toBeInTheDocument();
      expect(screen.getByText('node-a')).toBeInTheDocument();
    });
  });

  it('shows an empty state when no runners are deployed', async () => {
    apiGetMock.mockImplementation(async (path: string) => {
      if (path === '/api/runners') return { ok: true, json: async () => ({ runners: [] }) };
      throw new Error(`unexpected GET ${path}`);
    });
    renderWithProviders(<Runners />);
    await waitFor(() => {
      expect(screen.getByText('No runners deployed')).toBeInTheDocument();
    });
  });

  it('calls the drain endpoint when Drain is clicked', async () => {
    renderWithProviders(<Runners />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Drain' })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Drain' }));
    await waitFor(() => {
      expect(apiPostMock).toHaveBeenCalledWith('/api/runners/runner-gpt-4o/drain');
    });
  });

  it('scales a runner when the replica input is blurred', async () => {
    renderWithProviders(<Runners />);
    await waitFor(() => {
      expect(screen.getByRole('spinbutton')).toBeInTheDocument();
    });
    const input = screen.getByRole('spinbutton');
    fireEvent.change(input, { target: { value: '3' } });
    fireEvent.blur(input);
    await waitFor(() => {
      expect(apiPostMock).toHaveBeenCalledWith(
        '/api/runners/runner-gpt-4o/scale',
        expect.objectContaining({ body: JSON.stringify({ replicas: 3 }) }),
      );
    });
  });

  it('loads logs into the modal when Logs is clicked', async () => {
    renderWithProviders(<Runners />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Logs' })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Logs' }));
    await waitFor(() => {
      expect(screen.getByText(/log line 1/)).toBeInTheDocument();
      expect(screen.getByText(/log line 2/)).toBeInTheDocument();
    });
  });
});
