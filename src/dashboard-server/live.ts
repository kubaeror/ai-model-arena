import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { promises as fsp } from 'node:fs';
import {
  listRuns,
  getRunRecord,
  isRunCompleteByRunId,
  finalizeRunByRunId,
} from '../orchestrator/orchestrator.js';
import { type AuthConfig } from './auth.js';
import { verifyWsRequest } from './ws-auth.js';
import { createLogger } from '../logger/pino-logger.js';

export interface RunStatus {
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
  private logger = createLogger('ai-arena:live');
  private timers: NodeJS.Timeout[] = [];
  private pollTimer: NodeJS.Timeout | null = null;

  constructor(server: Server, auth: AuthConfig) {
    this.wss = new WebSocketServer({
      server,
      path: '/ws',
      // Cap message size at 1 MiB. ws's default is 100 MiB, which lets a
      // single client exhaust memory by sending a huge frame. (The /runner
      // and /lobby servers in routes/stream.ts use the same cap.)
      maxPayload: 1_048_576,
      verifyClient: (info: ClientInfo, cb) => {
        const result = verifyWsRequest(info, auth);
        (info.req as IncomingMessage & { _wsUser?: { sub: string; role: string } })._wsUser = result ?? undefined;
        cb(result !== null);
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

  private async getRunStatusList(): Promise<RunStatus[]> {
    try {
      const runs = await listRuns();
      const recent = runs.filter(r => r.status !== 'completed' || r.finishedAt == null);
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
    ws.on('close', () => { this.subs.delete(ws); this.clients.delete(ws); });
    ws.on('error', () => { this.subs.delete(ws); this.clients.delete(ws); });
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

  private async finalizeRuns(): Promise<void> {
    const running = (await listRuns()).filter((r) => r.status === 'running');
    for (const rec of running) {
      try {
        if (await isRunCompleteByRunId(rec.runId)) {
          await finalizeRunByRunId(rec.runId, this.logger);
          this.broadcastToSubscribers(rec.runId, { type: 'run_completed', runId: rec.runId });
          for (const [key] of this.convSeen) {
            if (key.startsWith(rec.runId)) {
              this.convSeen.delete(key);
              this.convMtime.delete(key);
            }
          }
        }
      } catch { /* ignore */ }
    }
  }

  private async broadcastRunStatus(): Promise<void> {
    const runs = await this.getRunStatusList();
    if (runs.length > 0) {
      this.broadcast({ type: 'run_status', runs });
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
