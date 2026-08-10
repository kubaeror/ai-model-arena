import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { LiveProvider, useRunLive } from '../../src/hooks/useLive.js';

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  url: string;
  protocols: string[];
  sent: string[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;

  constructor(url: string, protocols?: string[]) {
    this.url = url;
    this.protocols = protocols ?? [];
    MockWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  receive(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

describe('useLive resubscribe', () => {
  let origWs: typeof WebSocket;

  beforeEach(() => {
    origWs = globalThis.WebSocket;
    MockWebSocket.instances = [];
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => (k === 'ai-arena-token' ? 'test-token' : null),
      setItem: () => {},
      removeItem: () => {},
      clear: () => {},
    });
    vi.useFakeTimers();
  });

  afterEach(() => {
    globalThis.WebSocket = origWs;
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('re-sends subscriptions after a reconnect', async () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <LiveProvider>{children}</LiveProvider>
    );

    renderHook(() => useRunLive('run-1', 'gpt-4o'), { wrapper });
    expect(MockWebSocket.instances.length).toBe(1);
    const first = MockWebSocket.instances[0]!;

    // Simulate an initial send of a subscribe once open (useRunLive subscribes
    // on mount; the socket may not be open yet, so subscribe buffers in the
    // subsRef and only sends on the open handler).
    act(() => first.open());
    expect(first.sent).toContain(JSON.stringify({ type: 'subscribe', runId: 'run-1' }));

    // Drop the connection: the reconnect timer schedules a new socket.
    act(() => first.close());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });
    expect(MockWebSocket.instances.length).toBe(2);
    const second = MockWebSocket.instances[1]!;

    // The new socket must resubscribe the still-active run.
    act(() => second.open());
    expect(second.sent).toContain(JSON.stringify({ type: 'subscribe', runId: 'run-1' }));
  });

  it('sends unsubscribe on unmount and does not reconnect after disposal', async () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <LiveProvider>{children}</LiveProvider>
    );

    const { unmount } = renderHook(() => useRunLive('run-2', 'gpt-4o'), { wrapper });
    act(() => MockWebSocket.instances[0]!.open());

    unmount(); // unsubscribes run-2 + disposes the reconnect timer
    const first = MockWebSocket.instances[0]!;
    expect(first.sent).toContain(JSON.stringify({ type: 'unsubscribe', runId: 'run-2' }));

    // After disposal the socket close must NOT schedule a reconnect.
    act(() => first.close());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });
    expect(MockWebSocket.instances.length).toBe(1, 'no reconnect after provider disposal');
  });
});
