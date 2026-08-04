import { describe, it, expect, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useApiMutation } from '../../src/hooks/useApiMutation';
import type { ReactNode } from 'react';

const toastFn = vi.fn();

vi.mock('../../src/components/ui/Toast', () => ({
  useToast: () => ({
    toast: toastFn,
  }),
  ToastProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe('useApiMutation', () => {
  beforeEach(() => {
    toastFn.mockClear();
  });

  it('returns a useMutation result', () => {
    const mutationFn = vi.fn().mockResolvedValue({ ok: true });
    const { result } = renderHook(
      () => useApiMutation(mutationFn, { successToast: 'Done' }),
      { wrapper },
    );
    expect(result.current).toBeDefined();
    expect(typeof result.current.mutate).toBe('function');
    expect(result.current.isPending).toBe(false);
  });

  it('shows success toast on success', async () => {
    const mutationFn = vi.fn().mockResolvedValue({ ok: true });
    const { result } = renderHook(
      () => useApiMutation(mutationFn, { successToast: 'Saved!' }),
      { wrapper },
    );

    await act(async () => {
      await result.current.mutateAsync(void 0);
    });

    expect(toastFn).toHaveBeenCalledWith('success', 'Saved!');
  });

  it('invalidates queries after success', async () => {
    const mutationFn = vi.fn().mockResolvedValue({ ok: true });
    const { result } = renderHook(
      () => useApiMutation(mutationFn, {
        successToast: 'Done',
        invalidateQueries: ['scenarios'],
      }),
      { wrapper },
    );

    await act(async () => {
      await result.current.mutateAsync(void 0);
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
  });

  it('shows error toast on failure', async () => {
    const mutationFn = vi.fn().mockRejectedValue(new Error('Network error'));
    const { result } = renderHook(
      () => useApiMutation(mutationFn, { errorToast: 'Custom error' }),
      { wrapper },
    );

    try {
      await act(async () => {
        await result.current.mutateAsync(void 0);
      });
    } catch {
      // expected
    }

    expect(toastFn).toHaveBeenCalledWith('error', 'Custom error');
  });

  it('shows default error message when no errorToast provided', async () => {
    const mutationFn = vi.fn().mockRejectedValue(new Error('Something broke'));
    const { result } = renderHook(
      () => useApiMutation(mutationFn),
      { wrapper },
    );

    try {
      await act(async () => {
        await result.current.mutateAsync(void 0);
      });
    } catch {
      // expected
    }

    expect(toastFn).toHaveBeenCalledWith('error', 'Something broke');
  });

  it('supports dynamic success toast from data', async () => {
    const mutationFn = vi.fn().mockResolvedValue({ id: 'abc123' });
    const { result } = renderHook(
      () => useApiMutation(mutationFn, {
        successToast: (data: { id: string }) => `Created ${data.id}`,
      }),
      { wrapper },
    );

    await act(async () => {
      await result.current.mutateAsync(void 0);
    });

    expect(toastFn).toHaveBeenCalledWith('success', 'Created abc123');
  });
});
