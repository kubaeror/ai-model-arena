import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Settings } from '../../src/pages/Settings';
import { SettingsProvider } from '../../src/providers/SettingsProvider';

if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: (i: number) => [...store.keys()][i] ?? null,
      get length() {
        return store.size;
      },
    },
  });
}

const { apiGetMock, fetchMock, listWebhooksMock, registerWebhookMock, deleteWebhookMock } = vi.hoisted(() => ({
  apiGetMock: vi.fn().mockImplementation(async (path: string) => {
    if (path === '/api/secrets') {
      return { ok: true, json: async () => ({ platform: 'bare-metal', secrets: [{ envVar: 'OPENAI_API_KEY', status: 'missing' }] }) };
    }
    throw new Error(`unexpected api.get ${path}`);
  }),
  fetchMock: vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith('/api/providers')) {
      return new Response(
        JSON.stringify({
          builtin: [{ provider_id: 'openai', adapter: 'openai', api_base: 'https://api.openai.com/v1' }],
          custom: [{ id: 'my-prov', name: 'My Prov', provider_id: 'my-prov', adapter: 'anthropic', api_base: 'https://custom.example.com', auth_scheme: 'bearer', health: { reachable: true } }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    throw new Error(`unexpected fetch ${url}`);
  }),
  listWebhooksMock: vi.fn().mockResolvedValue([{ id: 1, url: 'https://example.com/hook', events: 'run.started', secret: null }]),
  registerWebhookMock: vi.fn().mockResolvedValue({ id: 2 }),
  deleteWebhookMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/lib/api', async () => {
  const actual = await vi.importActual('../../src/lib/api');
  return {
    ...actual,
    api: { ...actual.api, get: apiGetMock },
    listWebhooks: listWebhooksMock,
    registerWebhook: registerWebhookMock,
    deleteWebhook: deleteWebhookMock,
  };
});

function renderWithProviders(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <SettingsProvider>{ui}</SettingsProvider>
    </QueryClientProvider>,
  );
}

describe('Settings', () => {
  beforeEach(() => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  it('renders the General tab with theme options', () => {
    renderWithProviders(<Settings />);
    expect(screen.getByText('Settings')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'General' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'dark' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'light' })).toBeInTheDocument();
  });

  it('switches theme when a theme button is clicked', () => {
    renderWithProviders(<Settings />);
    fireEvent.click(screen.getByRole('button', { name: 'light' }));
    expect(localStorage.getItem('arena_theme')).toBe('light');
  });

  it('shows built-in and custom providers on the Providers tab', async () => {
    renderWithProviders(<Settings />);
    fireEvent.click(screen.getByRole('tab', { name: 'Providers' }));
    await waitFor(() => {
      expect(screen.getByText('Built-in Providers')).toBeInTheDocument();
      expect(screen.getAllByText('openai').length).toBeGreaterThanOrEqual(2);
      expect(screen.getByText('Custom Providers')).toBeInTheDocument();
      expect(screen.getByText('My Prov')).toBeInTheDocument();
      expect(screen.getByText('reachable')).toBeInTheDocument();
    });
  });

  it('lists webhooks and deletes one after confirmation', async () => {
    renderWithProviders(<Settings />);
    fireEvent.click(screen.getByRole('tab', { name: 'Webhooks' }));
    await waitFor(() => {
      expect(screen.getByText('https://example.com/hook')).toBeInTheDocument();
      expect(screen.getByText('run.started')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => {
      expect(deleteWebhookMock).toHaveBeenCalledWith(1);
    });
  });

  it('registers a webhook from the create form', async () => {
    renderWithProviders(<Settings />);
    fireEvent.click(screen.getByRole('tab', { name: 'Webhooks' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'New Webhook' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'New Webhook' }));
    fireEvent.change(screen.getByPlaceholderText('https://example.com/webhook'), { target: { value: 'https://hooks.test/hook' } });
    fireEvent.change(screen.getByPlaceholderText('run.started, run.completed'), { target: { value: 'run.started, run.completed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(registerWebhookMock).toHaveBeenCalledWith('https://hooks.test/hook', ['run.started', 'run.completed'], undefined);
    });
  });

  it('renders the secrets panel on the API Keys tab', async () => {
    renderWithProviders(<Settings />);
    fireEvent.click(screen.getByRole('tab', { name: 'API Keys' }));
    await waitFor(() => {
      expect(screen.getByText('OPENAI_API_KEY')).toBeInTheDocument();
      expect(screen.getByText('✗ Missing')).toBeInTheDocument();
    });
  });
});
