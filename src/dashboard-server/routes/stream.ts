import type { Request } from 'express';
import type { WebSocket } from 'ws';

const sessions = new Map<string, Set<WebSocket>>();
const runnerTokens = new Set<WebSocket>();

export function handleStreamUpgrade(ws: WebSocket, req: Request): void {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/runner') {
    runnerTokens.add(ws);
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'token' && msg.sessionId) {
          const subs = sessions.get(msg.sessionId);
          if (subs) for (const client of subs) client.send(JSON.stringify(msg));
        }
      } catch { /* ignore malformed */ }
    });
    ws.on('close', () => runnerTokens.delete(ws));
  } else if (url.pathname === '/ws') {
    const sessionId = url.searchParams.get('sessionId');
    if (!sessionId) { ws.close(); return; }
    let subs = sessions.get(sessionId);
    if (!subs) { subs = new Set(); sessions.set(sessionId, subs); }
    subs.add(ws);
    ws.on('close', () => {
      subs?.delete(ws);
      if (subs?.size === 0) sessions.delete(sessionId);
    });
  }
}
