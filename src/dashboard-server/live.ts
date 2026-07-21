import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { promises as fsp } from 'node:fs';
import {
  listArenaProcesses,
  listRuns,
  getRunRecord,
  isRunCompleteByRunId,
  finalizeRunByRunId,
} from '../orchestrator/orchestrator.js';
import * as pm2h from '../orchestrator/pm2-helpers.js';
import { isOnline, DASHBOARD_PROC_NAME } from '../orchestrator/pm2-helpers.js';
import { verifyToken, type AuthConfig } from './auth.js';
import { createLogger } from '../logger/pino-logger.js';

export interface ProcStatus {
  name: string;
  model?: string;
  scenario?: string;
  runId?: string;
  status: string;
  pid: number | null;
  cpu?: number;
  memory?: number;
  uptime?: number;
  restarts?: number;
  exitCode: number | null;
  online: boolean;
}

interface ClientInfo {
  req: IncomingMessage;
  secure: boolean;
  origin: string;
}

/**
 * WebSocket gateway. Broadcasts real-time events to connected dashboard clients:
 *  - process_status (every 2s, from pm2.list, enriched with run/model from index)
 *  - conversation_update (per subscribed run, new conversation.json entries)
 *  - log_line (per subscribed run, new PM2 log tail)
 *  - run_completed (when a watched run finishes)
 *
 * Workers are stateless; all state is read from outputs/ + the runs index. The
 * PM2 bus is not required for conversation state — we watch the filesystem.
 */
interface Pm2Proc {
  name?: string;
  pid?: number | null;
  monit?: { cpu?: number; memory?: number };
  pm2_env?: {
    status?: string;
    cpu?: number;
    memory?: number;
    uptime?: number;
    restarts?: number;
    exitCode?: number | null;
    pm_uptime?: number;
    unstable_restarts?: number;
    exit_code?: number | null;
  };
}

export class LiveHub {
  private wss: WebSocketServer;
  private subs = new Map<WebSocket, Set<string>>();
  private convSeen = new Map<string, number>();
  private convMtime = new Map<string, number>();
  private logSize = new Map<string, number>();
  private logger = createLogger('ai-arena:live');
  private timers: NodeJS.Timeout[] = [];
  private pollTimer: NodeJS.Timeout | null = null;

  constructor(server: Server, auth: AuthConfig) {
    this.wss = new WebSocketServer({
      server,
      path: '/ws',
      verifyClient: (info: ClientInfo, cb) => cb(this.verify(info, auth)),
    });
    this.wss.on('connection', (ws, req) => this.onConnection(ws, req));
    void pm2h.pm2ConnectPersistent().catch((e) =>
      this.logger.warn('PM2 persistent connect failed', { error: String(e) }),
    );
    this.start();
  }

  private verify(info: ClientInfo, auth: AuthConfig): boolean {
    try {
      const protocols = String(info.req.headers['sec-websocket-protocol'] ?? '');
      const protocolToken = protocols
        .split(',')
        .map((p) => p.trim())
        .find((p) => p !== 'access_token' && p.length > 0);

      const token = protocolToken;
      if (!token) return false;
      return verifyToken(auth, token) != null;
    } catch {
      return false;
    }
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

  /** Build a procName -> {model, scenario, runId} map from the runs index. */
  private procMetaMap(): Map<string, { model: string; scenario: string; runId: string }> {
    const map = new Map<string, { model: string; scenario: string; runId: string }>();
    for (const rec of listRuns()) {
      for (const m of rec.perModel) {
        map.set(m.procName, { model: m.model, scenario: rec.scenario, runId: rec.runId });
      }
    }
    return map;
  }

  private enrich(procs: Pm2Proc[]): ProcStatus[] {
    const meta = this.procMetaMap();
    return procs
      .filter((p) => p.name && p.name !== DASHBOARD_PROC_NAME)
      .map((p) => {
        const m = meta.get(p.name ?? '');
        return {
          name: p.name ?? '?',
          model: m?.model,
          scenario: m?.scenario,
          runId: m?.runId,
          status: p.pm2_env?.status ?? '?',
          pid: p.pid ?? null,
          cpu: p.monit?.cpu,
          memory: p.monit?.memory,
          uptime: p.pm2_env?.pm_uptime,
          restarts: p.pm2_env?.unstable_restarts,
          exitCode: p.pm2_env?.exit_code ?? null,
          online: isOnline(p),
        };
      });
  }

  private async getProcessStatus(): Promise<ProcStatus[]> {
    try {
      return this.enrich((await listArenaProcesses()) as Pm2Proc[]);
    } catch {
      return [];
    }
  }

  private onConnection(ws: WebSocket, _req: IncomingMessage): void {
    this.subs.set(ws, new Set());
    void this.getProcessStatus()
      .then((processes) => this.send(ws, { type: 'process_status', processes }))
      .catch((err) => this.logger.warn('Failed to get process status on connect', { error: String(err) }));
    ws.on('message', (data) => this.onMessage(ws, data));
    ws.on('close', () => this.subs.delete(ws));
    ws.on('error', () => this.subs.delete(ws));
  }

  private onMessage(ws: WebSocket, data: { toString: () => string }): void {
    let msg: { type?: string; runId?: string };
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (msg.type === 'subscribe' && typeof msg.runId === 'string') {
      this.subs.get(ws)?.add(msg.runId);
      void this.sendRunSnapshot(ws, msg.runId);
    } else if (msg.type === 'unsubscribe' && typeof msg.runId === 'string') {
      this.subs.get(ws)?.delete(msg.runId);
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

  /** On subscribe, immediately send the current conversation + recent log tail. */
  private async sendRunSnapshot(ws: WebSocket, runId: string): Promise<void> {
    const rec = getRunRecord(runId);
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
      } catch {
        /* ignore */
      }
      try {
        const logStat = await fsp.stat(m.logFile).catch(() => null);
        const content = logStat ? await fsp.readFile(m.logFile, 'utf8') : '';
        this.logSize.set(key, Buffer.byteLength(content));
        this.send(ws, { type: 'log_line', runId, model: m.model, lines: content.split(/\r?\n/).slice(-200) });
      } catch {
        /* ignore */
      }
    }
  }

  /** Poll subscribed runs' conversation.json for newly-appended entries. */
  private async pollConversationsAsync(): Promise<void> {
    for (const runId of this.subscribedRunIds()) {
      const rec = getRunRecord(runId);
      if (!rec) continue;
      for (const m of rec.perModel) {
        const key = `${runId}:${m.model}`;
        let stat: Awaited<ReturnType<typeof fsp.stat>>;
        try {
          stat = await fsp.stat(m.conversationPath);
        } catch {
          continue;
        }
        if (this.convMtime.get(key) === stat.mtimeMs) continue;
        this.convMtime.set(key, stat.mtimeMs);
        let conv: { entries?: unknown[] };
        try {
          conv = JSON.parse(await fsp.readFile(m.conversationPath, 'utf8'));
        } catch {
          continue;
        }
        const entries = conv.entries ?? [];
        const seen = this.convSeen.get(key) ?? 0;
        if (entries.length > seen) {
          this.convSeen.set(key, entries.length);
          for (const entry of entries.slice(seen)) {
            this.broadcastToSubscribers(runId, { type: 'conversation_update', runId, model: m.model, entry });
          }
        }
      }
    }
  }

  /** Tail PM2 log files for subscribed runs (byte-offset based, cheap when idle). */
  private async pollLogsAsync(): Promise<void> {
    for (const runId of this.subscribedRunIds()) {
      const rec = getRunRecord(runId);
      if (!rec) continue;
      for (const m of rec.perModel) {
        const key = `${runId}:${m.model}`;
        let size: number;
        try {
          size = (await fsp.stat(m.logFile)).size;
        } catch {
          continue;
        }
        const last = this.logSize.get(key) ?? 0;
        if (size < last) {
          this.logSize.set(key, size);
          continue;
        }
        if (size === last) continue;
        const fh = await fsp.open(m.logFile, 'r');
        try {
          const len = size - last;
          const buf = Buffer.alloc(len);
          await fh.read(buf, 0, len, last);
          this.logSize.set(key, size);
          const text = buf.toString('utf8');
          let lines = text.split(/\r?\n/);
          if (lines.length && lines[lines.length - 1] === '') lines = lines.slice(0, -1);
          if (lines.length) this.broadcastToSubscribers(runId, { type: 'log_line', runId, model: m.model, lines });
        } catch {
          /* ignore */
        } finally {
          await fh.close();
        }
      }
    }
  }

  /** Finalize runs whose workers have all stopped (also picks up CLI-started runs). */
  private async finalizeRuns(): Promise<void> {
    const running = listRuns().filter((r) => r.status === 'running');
    for (const rec of running) {
      try {
        if (await isRunCompleteByRunId(rec.runId)) {
          await finalizeRunByRunId(rec.runId, this.logger);
          this.broadcastToSubscribers(rec.runId, { type: 'run_completed', runId: rec.runId });
          // Clean up per-run tracking maps to prevent memory leaks
          for (const [key] of this.convSeen) {
            if (key.startsWith(rec.runId)) {
              this.convSeen.delete(key);
              this.convMtime.delete(key);
              this.logSize.delete(key);
            }
          }
        }
      } catch {
        /* ignore */
      }
    }
  }

  private async broadcastProcessStatus(): Promise<void> {
    const processes = await this.getProcessStatus();
    this.broadcast({ type: 'process_status', processes });
  }

  private schedulePoll(): void {
    this.pollTimer = setTimeout(() => {
      void Promise.all([
        this.pollConversationsAsync().catch((e) =>
          this.logger.warn('pollConversations error', { error: String(e) }),
        ),
        this.pollLogsAsync().catch((e) =>
          this.logger.warn('pollLogs error', { error: String(e) }),
        ),
      ]).finally(() => {
        if (this.pollTimer !== null) this.schedulePoll();
      });
    }, 1000);
  }

  start(): void {
    this.timers.push(setInterval(() => { void this.broadcastProcessStatus(); }, 2000));
    this.schedulePoll();
    this.timers.push(setInterval(() => { void this.finalizeRuns(); }, 3000));
    void this.broadcastProcessStatus();
  }

  close(): void {
    if (this.pollTimer !== null) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.wss.close();
    void pm2h.pm2DisconnectPersistent().catch(() => undefined);
  }
}

