import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SecretsPanel } from '../../src/components/SecretsPanel';

const { putSpy, getSpy, delSpy } = vi.hoisted(() => ({
  putSpy: vi.fn(),
  getSpy: vi.fn(),
  delSpy: vi.fn(),
}));

vi.mock('../../src/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/api')>();
  return { ...actual, api: { ...actual.api, get: getSpy, put: putSpy, del: delSpy } };
});

function okResponse(body: unknown) {
  return { ok: true, json: async () => body };
}

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><SecretsPanel /></QueryClientProvider>);
}

describe('SecretsPanel', () => {
  beforeEach(() => {
    putSpy.mockReset();
    getSpy.mockReset();
    delSpy.mockReset();
    getSpy.mockResolvedValue(
      okResponse({
        platform: 'bare-metal',
        secrets: [{ envVar: 'OPENAI_API_KEY', status: 'missing' }],
      }),
    );
    putSpy.mockResolvedValue(okResponse({ ok: true }));
  });

  it('calls api.put when saving a secret', async () => {
    const user = userEvent.setup();
    renderPanel();

    const setButton = await screen.findByText('Set');
    await user.click(setButton);

    const input = screen.getByPlaceholderText('Enter key...');
    await user.type(input, 'sk-test-123');

    await user.click(screen.getByText('Save'));

    await waitFor(() => {
      expect(putSpy).toHaveBeenCalledWith(
        '/api/secrets/OPENAI_API_KEY',
        expect.objectContaining({
          body: JSON.stringify({ value: 'sk-test-123' }),
        }),
      );
    });
  });
});
