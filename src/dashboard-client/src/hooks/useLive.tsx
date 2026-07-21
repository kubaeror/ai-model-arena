import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { ProcStatus, ConversationEntry } from '../lib/types.js';
import { getToken } from '../lib/api.js';

interface RunLiveState {
  entries: ConversationEntry[];
  logLines: string[];
  completed: boolean;
}

interface LiveContextValue {
  processes: ProcStatus[];
  connected: boolean;
  subscribe: (runId: string) => void;
  unsubscribe: (runId: string) => void;
  getRunState: (runId: string, model: string) => RunLiveState;
}

const LiveContext = createContext<LiveContextValue | null>(null);

function wsUrl(): string {
  const override = import.meta.env.VITE_WS_URL as string | undefined;
  if (override) return override;
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/ws`;
}

const EMPTY: RunLiveState = { entries: [], logLines: [], completed: false };

export function LiveProvider({ children }: { children: ReactNode }) {
  const [processes, setProcesses] = useState<ProcStatus[]>([]);
  const [connected, setConnected] = useState(false);
  const [, forceRender] = useState(0);
  const wsRef = useRef<WebSocket | null>(null);
  const runStateRef = useRef<Map<string, RunLiveState>>(new Map());
  const rerender = useCallback(() => forceRender((v) => v + 1), []);

  useEffect(() => {
    const token = getToken();
    if (!token) return;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;

    const connect = () => {
      const ws = new WebSocket(`${wsUrl()}`, [token, 'access_token']);
      wsRef.current = ws;
      ws.onopen = () => setConnected(true);
      ws.onclose = () => {
        setConnected(false);
        if (!disposed) reconnectTimer = setTimeout(connect, 2000);
      };
      ws.onerror = () => ws.close();
      ws.onmessage = (ev) => {
        let msg: { type?: string; [k: string]: unknown };
        try {
          msg = JSON.parse(ev.data as string);
        } catch {
          return;
        }
        switch (msg.type) {
          case 'process_status': {
            setProcesses((msg.processes as ProcStatus[]) ?? []);
            break;
          }
          case 'conversation_snapshot': {
            const key = `${msg.runId}:${msg.model}`;
            const conv = (msg.conversation as { entries?: ConversationEntry[] }) ?? {};
            const st = runStateRef.current.get(key) ?? { ...EMPTY };
            st.entries = conv.entries ?? [];
            runStateRef.current.set(key, st);
            rerender();
            break;
          }
          case 'conversation_update': {
            const key = `${msg.runId}:${msg.model}`;
            const st = runStateRef.current.get(key) ?? { ...EMPTY };
            st.entries = [...st.entries, msg.entry as ConversationEntry];
            runStateRef.current.set(key, st);
            rerender();
            break;
          }
          case 'log_line': {
            const key = `${msg.runId}:${msg.model}`;
            const st = runStateRef.current.get(key) ?? { ...EMPTY };
            const lines = (msg.lines as string[]) ?? [];
            st.logLines = [...st.logLines, ...lines].slice(-2000);
            runStateRef.current.set(key, st);
            rerender();
            break;
          }
          case 'run_completed': {
            const rid = msg.runId as string;
            for (const [k, st] of runStateRef.current) {
              if (k.startsWith(`${rid}:`)) st.completed = true;
            }
            rerender();
            break;
          }
        }
      };
    };
    connect();
    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      wsRef.current?.close();
    };
  }, [rerender]);

  const subscribe = useCallback((runId: string) => {
    wsRef.current?.send(JSON.stringify({ type: 'subscribe', runId }));
  }, []);
  const unsubscribe = useCallback((runId: string) => {
    wsRef.current?.send(JSON.stringify({ type: 'unsubscribe', runId }));
  }, []);
  const getRunState = useCallback(
    (runId: string, model: string): RunLiveState => {
      return runStateRef.current.get(`${runId}:${model}`) ?? EMPTY;
    },
    [],
  );

  return (
    <LiveContext.Provider value={{ processes, connected, subscribe, unsubscribe, getRunState }}>
      {children}
    </LiveContext.Provider>
  );
}

export function useLive(): LiveContextValue {
  const ctx = useContext(LiveContext);
  if (!ctx) throw new Error('useLive must be used within a LiveProvider');
  return ctx;
}

/** Hook for a run detail view: subscribes to a run and accumulates one model's live state. */
export function useRunLive(runId: string | undefined, model: string | undefined) {
  const { subscribe, unsubscribe, getRunState, processes } = useLive();
  useEffect(() => {
    if (!runId) return;
    subscribe(runId);
    return () => unsubscribe(runId);
  }, [runId, subscribe, unsubscribe]);
  const state = runId && model ? getRunState(runId, model) : EMPTY;
  const online = runId ? processes.some((p) => p.runId === runId && p.online) : false;
  return { entries: state.entries, logLines: state.logLines, completed: state.completed, online };
}
