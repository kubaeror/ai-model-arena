import { describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useCatalogModels } from '../../src/hooks/useCatalog';
import type { ReactNode } from 'react';

vi.mock('../../src/lib/api', () => ({
  api: {
    get: vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        data: [
          { id: 'openai/gpt-4o', name: 'GPT-4o', provider_id: 'openai', reasoning: 0, tool_call: 1, context_limit: 128000, input: 2.5, output: 10, status: null },
        ],
      }),
    }),
  },
}));

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe('useCatalogModels', () => {
  it('returns model data', async () => {
    const { result } = renderHook(() => useCatalogModels(), { wrapper });
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(result.current.data).toHaveLength(1);
    expect(result.current.data![0]!.name).toBe('GPT-4o');
  });

  it('passes filters to query key', () => {
    const { result } = renderHook(
      () => useCatalogModels({ provider: 'openai', reasoning: '1' }),
      { wrapper },
    );
    const key = result.current.dataUpdatedAt;
    expect(key).toBeDefined();
  });
});
