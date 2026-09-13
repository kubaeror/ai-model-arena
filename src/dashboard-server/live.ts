import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { promises as fsp } from 'node:fs';
import {
  listLiveRuns,
  getRunRecord,
  finalizeRunByRunId,
  shouldAttemptFinalize,
  prepareRunFinalization,
  isStaleRunningRun,
  failNonTerminalModels,
  isRunCancelled,
  type RunIndexRecord,
} from '../orchestrator/orchestrator.js';
import { type AuthConfig } from './auth.js';
import { verifyWsRequest } from './ws-auth.js';
import { createLogger } from '../logger/pino-logger.js';
import type { Logger } from '../types.js';
import { isOwnerAllowed } from '../auth/rbac.js';

/** Ownership gate for WS subscriptions: admins pass; otherwise the actor
 *  must match the run's createdBy. Missing/unknown runs deny. Mirrors the
 *  REST allowIfRunOwner contract (default-DENY for ownerless runs). */
export async function canSubscribeToRun(
  user: { sub?: string; role?: string },
  runId: string,
): Promise<boolean> {
  const rec = await getRunRecord(runId);
  if (!rec) return false;
  return isOwnerAllowed(user, rec.createdBy);
}

interface RunStatus {
  runId: string;
  scenario: string;
  models: Array<{ model: string; status: string }>;
  status: string;
  startedAt: string;
  finishedAt?: string;
}

interface ClientInfo {
  req: IncomingMessage;
  secure: boolean;
  origin: string;
}

/**
 * Status feed policy: 'completed' is the only terminal status that leaves the
 * live list. A 'finalizing' run is still in flight (aggregation/ledger/
 * notification) and must stay visible until it completes.
 */
export function selectLiveRuns<T extends { status: string }>(runs: T[]): T[] {
  return runs.filter((r) => r.status !== 'completed');
}

/** How long a live-run query result is reused across status/finalize polls. */
const LIVE_RUN_CACHE_MS = 1500;

/**
 * Read new bytes appended to a log file. `offset` beyond the current size means
 * the file was truncated or rotated: restart from byte 0 instead of allocating
 * a negative-length buffer (which threw and permanently stalled the tail).
 */
export async function readLogAppend(
  filePath: string,
  offset: number,
): Promise<{ offset: number; lines: string[] }> {
  const stat = await fsp.stat(filePath);
  const clamped = offset < 0 ? 0 : offset;
  const start = clamped > stat.size ? 0 : clamped;
  if (stat.size <= start) return { offset: start, lines: [] };
  const length = stat.size - start;
  const fd = await fsp.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await fd.read(buffer, 0, length, start);
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split(/\r?\n/).filter(Boolean);
    return { offset: start + bytesRead, lines };
  } finally {
    await fd.close();
  }
}

/**
 * Dead-runner reconciliation for a run still 'running' past RUN_STALE_AFTER_MS
 * whose cancel signal is absent: the runner died without writing a terminal
 * model row (e.g. its task dead-lettered), so the normal finalize gate would
 * never admit it. Non-terminal rows are failed (runner died) and the run then
 * finalizes through the normal gate. Fresh runs and runs with a live cancel
 * signal are untouched. Returns true when the run was stale and reconciled.
 */
export async function reconcileStaleRunningRun(
  run: Pick<RunIndexRecord, 'runId' | 'status' | 'startedAt'>,
  logger: Logger,
  now = Date.now(),
): Promise<boolean> {
  if (!isStaleRunningRun(run, now)) return false;
  if (await isRunCancelled(run.runId)) return false;
  await failNonTerminalModels(run.runId, logger);
  return true;
}

/**
 * One watcher tick for a single run, gated by prepareRunFinalization: a stopped
 * run may finalize only when every per-model row is terminal (rows are the
 * per-model acks, so one runner clearing the cancel signal early must not
 * release the run) and the signal is absent or the grace window elapsed. Past
 * the grace window stale rows are force-stopped for dead-runner recovery, and
 * a stale 'running' run has its dead runner's rows failed first. Returns true
 * only when this tick won the finalization claim.
 */
export async function attemptFinalizeCandidate(
  run: Pick<RunIndexRecord, 'runId' | 'status' | 'finishedAt' | 'startedAt'>,
  logger: Logger,
): Promise<boolean> {
  const reaped = await reconcileStaleRunningRun(run, logger);
  if (!(await prepareRunFinalization(run.runId))) return false;
  return finalizeRunByRunId(run.runId, logger, undefined, reaped);
}

/**
 * WebSocket gateway. Broadcasts real-time events to connected dashboard clients:
 *  - run_status (every 2s, from the runs DB index)
 *  - conversation_update (per subscribed run, new conversation.json entries)
 *  - run_completed (when a watched run finishes)
 *
 * State is read from outputs/ + the runs index. No PM2 dependency.
 */
export class LiveHub {
  private wss: WebSocketServer;
  private subs = new Map<WebSocket, Set<string>>();
  private clients = new Map<WebSocket, { sub: string; role: string }>();
  private convSeen = new Map<string, number>();
  private convMtime = new Map<string, number>();
  private logOffset = new Map<string, number>();
  private logMtime = new Map<string, number>();
  private logger = createLogger('ai-arena:live');
  private timers: NodeJS.Timeout[] = [];
  private pollTimer: NodeJS.Timeout | null = null;
  private liveRunsCache: { at: number; runs: RunIndexRecord[] } | null = null;

  constructor(server: Server, auth: AuthConfig) {
    this.wss = new WebSocketServer({
      server,
      path: '/ws',
      // Cap message size at 1 MiB. ws's default is 100 MiB, which lets a
      // single client exhaust memory by sending a huge frame. (The /runner
      // and /lobby servers in routes/stream.ts use the same cap.)
      maxPayload: 1_048_576,
      verifyClient: (info: ClientInfo, cb) => {
        void verifyWsRequest(info, auth).then((result) => {
          (info.req as IncomingMessage & { _wsUser?: { sub: string; role: string } })._wsUser = result ?? undefined;
          cb(result !== null);
        });
      },
    });
    this.wss.on('connection', (ws, req) => this.onConnection(ws, req));
    this.start();
  }

  private send(ws: WebSocket, msg: unknown): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  private broadcast(msg: unknown): void {
    const data = JSON.stringify(msg);
    for (const ws of this.wss.clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    }
  }

  private async liveRuns(): Promise<RunIndexRecord[]> {
    const cached = this.liveRunsCache;
    if (cached && Date.now() - cached.at < LIVE_RUN_CACHE_MS) return cached.runs;
    const runs = await listLiveRuns();
    this.liveRunsCache = { at: Date.now(), runs };
    return runs;
  }

  private async getRunStatusList(): Promise<RunStatus[]> {
    try {
      const recent = selectLiveRuns(await this.liveRuns());
      return recent.map(r => ({
        runId: r.runId,
        scenario: r.scenario,
        models: r.perModel.map(m => ({ model: m.model, status: m.status })),
        status: r.status,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt ?? undefined,
      }));
    } catch {
      return [];
    }
  }

  private onConnection(ws: WebSocket, req: IncomingMessage): void {
    const user = (req as IncomingMessage & { _wsUser?: { sub: string; role: string } })._wsUser ?? { sub: 'anonymous', role: 'viewer' };
    this.clients.set(ws, user);
    this.subs.set(ws, new Set());
    void this.getRunStatusList()
      .then((statuses) => this.send(ws, { type: 'run_status', runs: statuses }))
      .catch((err) => this.logger.warn('Failed to get run status on connect', { error: String(err) }));
    ws.on('message', (data) => this.onMessage(ws, data));
    const release = (): void => {
      const runs = this.subs.get(ws);
      this.subs.delete(ws);
      this.clients.delete(ws);
      if (runs) for (const runId of runs) this.releaseRunState(runId);
    };
    ws.on('close', release);
    ws.on('error', release);
  }

  private onMessage(ws: WebSocket, data: { toString: () => string }): void {
    let msg: { type?: string; runId?: string };
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (msg.type === 'subscribe' && typeof msg.runId === 'string') {
      const user = this.clients.get(ws);
      const runId = msg.runId;
      // Ownership gate (IDOR fix): a viewer may only subscribe to their own
      // runs; admins pass. Denials get an explicit error frame instead of a
      // silent no-op.
      void canSubscribeToRun(user ?? { sub: undefined, role: 'viewer' }, runId)
        .then((allowed) => {
          if (!allowed) {
            this.send(ws, { type: 'error', error: 'forbidden: not the run owner' });
            return;
          }
          this.subs.get(ws)?.add(runId);
          void this.sendRunSnapshot(ws, runId);
        });
    } else if (msg.type === 'unsubscribe' && typeof msg.runId === 'string') {
      if (this.subs.get(ws)?.delete(msg.runId)) this.releaseRunState(msg.runId);
    }
  }

  /** Delete all per-run tail state once no subscriber references the run. */
  private releaseRunState(runId: string): void {
    for (const set of this.subs.values()) {
      if (set.has(runId)) return;
    }
    this.cleanupRunState(runId);
  }

  private cleanupRunState(runId: string): void {
    const prefix = `${runId}:`;
    for (const map of [this.convSeen, this.convMtime, this.logOffset, this.logMtime]) {
      for (const key of map.keys()) {
        if (key.startsWith(prefix)) map.delete(key);
      }
    }
  }

  private subscribedRunIds(): Set<string> {
    const set = new Set<string>();
    for (const s of this.subs.values()) for (const r of s) set.add(r);
    return set;
  }

  private broadcastToSubscribers(runId: string, msg: unknown): void {
    const data = JSON.stringify(msg);
    for (const [ws, set] of this.subs) {
      if (set.has(runId) && ws.readyState === WebSocket.OPEN) ws.send(data);
    }
  }

  private async sendRunSnapshot(ws: WebSocket, runId: string): Promise<void> {
    const rec = await getRunRecord(runId);
    if (!rec) return;
    for (const m of rec.perModel) {
      const key = `${runId}:${m.model}`;
      try {
        const stat = await fsp.stat(m.conversationPath).catch(() => null);
        if (stat) {
          const conv = JSON.parse(await fsp.readFile(m.conversationPath, 'utf8'));
          const count = conv.entries?.length ?? 0;
          this.convSeen.set(key, count);
          this.convMtime.set(key, stat.mtimeMs);
          this.send(ws, { type: 'conversation_snapshot', runId, model: m.model, conversation: conv });
        }
      } catch { /* ignore */ }
    }
  }

  private async pollConversationsAsync(): Promise<void> {
    for (const runId of this.subscribedRunIds()) {
      const rec = await getRunRecord(runId);
      if (!rec) continue;
      for (const m of rec.perModel) {
        const key = `${runId}:${m.model}`;
        try {
          const stat = await fsp.stat(m.conversationPath);
          if (this.convMtime.get(key) !== stat.mtimeMs) {
            this.convMtime.set(key, stat.mtimeMs);
            const conv = JSON.parse(await fsp.readFile(m.conversationPath, 'utf8')) as { entries?: unknown[] };
            const entries = conv.entries ?? [];
            const seen = this.convSeen.get(key) ?? 0;
            if (entries.length > seen) {
              this.convSeen.set(key, entries.length);
              for (const entry of entries.slice(seen)) {
                this.broadcastToSubscribers(runId, { type: 'conversation_update', runId, model: m.model, entry });
              }
            }
          }
        } catch {
          // Conversation may not exist yet — fall through to the log tail.
        }

        if (m.logFile) {
          try {
            const logStat = await fsp.stat(m.logFile);
            const offset = this.logOffset.get(key) ?? 0;
            if (this.logMtime.get(key) !== logStat.mtimeMs || logStat.size < offset) {
              const appended = await readLogAppend(m.logFile, offset);
              this.logOffset.set(key, appended.offset);
              this.logMtime.set(key, logStat.mtimeMs);
              if (appended.lines.length > 0) {
                this.broadcastToSubscribers(runId, { type: 'log_line', runId, model: m.model, lines: appended.lines });
              }
            }
          } catch { /* log tailing is best-effort */ }
        }
      }
    }
  }

  private async finalizeRuns(): Promise<void> {
    // 'stopped' runs are included: each runner writes its own model row
    // 'stopped' when it observes the stop, and a stopped run whose runner died
    // would otherwise never finalize (no aggregation, no reservation release).
    // A stopped run whose rows are still non-terminal, or whose cancel signal
    // is still live inside the grace window, is held (see
    // attemptFinalizeCandidate); past the grace window its stale rows are
    // force-stopped so the run can finalize. Stale 'finalizing' runs are
    // also included so a crash after the claim (aggregation/ledger/
    // notification) is retried instead of stranding the run; shouldAttemptFinalize
    // only admits a finalizing run whose claim exceeded FINALIZE_STALE_MS, so
    // an active finalizer is never raced. finalizeRunByRunId wins or loses the
    // atomic claim, so racing the runner is harmless; only the winner's call
    // returns true and gets the run_completed broadcast.
    let candidates: RunIndexRecord[];
    try {
      candidates = (await this.liveRuns()).filter((r) => shouldAttemptFinalize(r));
    } catch {
      return;
    }
    for (const rec of candidates) {
      try {
        const finalized = await attemptFinalizeCandidate(rec, this.logger);
        if (!finalized) continue;
        this.broadcastToSubscribers(rec.runId, { type: 'run_completed', runId: rec.runId });
        this.cleanupRunState(rec.runId);
        this.liveRunsCache = null;
      } catch { /* ignore */ }
    }
  }

  private async broadcastRunStatus(): Promise<void> {
    const runs = await this.getRunStatusList();
    if (runs.length > 0) {
      this.broadcast({ type: 'run_status', runs });
      this.broadcast({
        type: 'process_status',
        processes: runs.flatMap((r) => r.models.map((m) => ({
          name: `${r.runId}:${m.model}`,
          runId: r.runId,
          model: m.model,
          scenario: r.scenario,
          status: m.status,
          online: m.status === 'running',
        }))),
      });
    }
  }

  private schedulePoll(): void {
    this.pollTimer = setTimeout(() => {
      void this.pollConversationsAsync().catch((e) =>
        this.logger.warn('pollConversations error', { error: String(e) }),
      ).finally(() => {
        if (this.pollTimer !== null) this.schedulePoll();
      });
    }, 1000);
  }

  start(): void {
    this.timers.push(setInterval(() => { void this.broadcastRunStatus(); }, 2000));
    this.schedulePoll();
    this.timers.push(setInterval(() => { void this.finalizeRuns(); }, 3000));
    void this.broadcastRunStatus();
  }

  close(): void {
    if (this.pollTimer !== null) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.wss.close();
  }
}
