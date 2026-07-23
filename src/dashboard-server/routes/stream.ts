import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';

/**
 * Session-scoped WebSocket relay for runner ↔ dashboard communication.
 *
 * Two paths:
 *   /runner      — runners connect here and relay messages by sessionId
 *   /lobby       — dashboard clients connect with ?sessionId= to receive runner messages
 *
 * This is separate from the LiveHub (/ws) which handles process status,
 * conversation streaming, and log tailing for the main dashboard.
 */

const sessions = new Map<string, Set<WebSocket>>();
const runnerSockets = new Set<WebSocket>();

let runnerWss: WebSocketServer | null = null;
let lobbyWss: WebSocketServer | null = null;

/** Attach stream WebSocket handlers to an existing HTTP server. */
export function attachStreamWs(server: Server): void {
  // Runner endpoint: runners connect here
  runnerWss = new WebSocketServer({ server, path: '/runner' });
  runnerWss.on('connection', (ws) => {
    runnerSockets.add(ws);
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'token' && msg.sessionId) {
          const subs = sessions.get(msg.sessionId);
          if (subs) for (const client of subs) client.send(JSON.stringify(msg));
        }
      } catch { /* ignore malformed */ }
    });
    ws.on('close', () => runnerSockets.delete(ws));
  });

  // Lobby endpoint: dashboard clients subscribe to a session
  lobbyWss = new WebSocketServer({ server, path: '/lobby' });
  lobbyWss.on('connection', (ws, req) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const sessionId = url.searchParams.get('sessionId');
    if (!sessionId) { ws.close(4000, 'Missing sessionId query parameter'); return; }

    let subs = sessions.get(sessionId);
    if (!subs) { subs = new Set(); sessions.set(sessionId, subs); }
    subs.add(ws);

    ws.on('close', () => {
      subs?.delete(ws);
      if (subs?.size === 0) sessions.delete(sessionId);
    });
  });
}
