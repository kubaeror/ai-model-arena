import { WebSocketServer, WebSocket } from 'ws';
import type { Server, IncomingMessage } from 'node:http';
import { verifyToken, type AuthConfig } from '../auth.js';
import { createLogger } from '../../logger/pino-logger.js';

/**
 * Session-scoped WebSocket relay for runner ↔ dashboard communication.
 *
 * Two paths:
 *   /runner      — runners connect here and relay messages by sessionId
 *   /lobby       — dashboard clients connect with ?sessionId= to receive runner messages
 *
 * This is separate from the LiveHub (/ws) which handles process status,
 * conversation streaming, and log tailing for the main dashboard.
 *
 * Authentication: every connection (runner or lobby) must present a valid JWT
 * either via the `Sec-WebSocket-Protocol` header (as `access_token, <jwt>`,
 * matching the LiveHub convention) or via a `?token=<jwt>` query parameter.
 * Unauthenticated connections are rejected at the upgrade handshake.
 */

const MAX_PAYLOAD_BYTES = 1_048_576; // 1 MiB hard cap per WS message frame

const sessions = new Map<string, Set<WebSocket>>();
const runnerSockets = new Set<WebSocket>();

let runnerWss: WebSocketServer | null = null;
let lobbyWss: WebSocketServer | null = null;

const logger = createLogger('ai-arena:stream');

interface VerifyInfo {
  req: IncomingMessage;
}

/**
 * Extract a JWT from an incoming WebSocket upgrade request.
 *
 * Accepts either:
 *   1. `Sec-WebSocket-Protocol: access_token, <jwt>` (browser-friendly; the
 *      client opens with `new WebSocket(url, ['access_token', '<jwt>'])`).
 *   2. `?token=<jwt>` query parameter on the upgrade URL.
 *
 * Returns the verified `{ sub, role }` principal, or `null` if no valid
 * credential is present — in which case the caller rejects the upgrade.
 */
function verifyWsRequest(info: VerifyInfo, auth: AuthConfig): { sub: string; role: string } | null {
  // 1. Sec-WebSocket-Protocol header (mirror LiveHub's convention)
  const protocols = String(info.req.headers['sec-websocket-protocol'] ?? '');
  const protocolToken = protocols
    .split(',')
    .map((p) => p.trim())
    .find((p) => p !== 'access_token' && p.length > 0);
  if (protocolToken) {
    return verifyToken(auth, protocolToken);
  }

  // 2. ?token=<jwt> query parameter
  try {
    const url = new URL(info.req.url ?? '/', 'http://localhost');
    const queryToken = url.searchParams.get('token');
    if (queryToken) return verifyToken(auth, queryToken);
  } catch {
    // malformed URL — fall through to reject
  }

  return null;
}

/** Attach stream WebSocket handlers to an existing HTTP server. */
export function attachStreamWs(server: Server, auth: AuthConfig): void {
  // Runner endpoint: runners connect here (authenticated)
  runnerWss = new WebSocketServer({
    server,
    path: '/runner',
    maxPayload: MAX_PAYLOAD_BYTES,
    verifyClient: (info: VerifyInfo, cb) => {
      const result = verifyWsRequest(info, auth);
      if (result === null) {
        logger.warn('Rejected unauthenticated /runner WebSocket upgrade', {
          remoteAddress: info.req.socket.remoteAddress,
        });
        cb(false, 401, 'Unauthorized');
        return;
      }
      cb(true);
    },
  });
  runnerWss.on('connection', (ws) => {
    runnerSockets.add(ws);
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg && typeof msg === 'object' && msg.type === 'token' && typeof msg.sessionId === 'string') {
          const subs = sessions.get(msg.sessionId);
          if (subs) for (const client of subs) client.send(JSON.stringify(msg));
        }
      } catch {
        /* ignore malformed runner messages */
      }
    });
    ws.on('close', () => runnerSockets.delete(ws));
    ws.on('error', () => runnerSockets.delete(ws));
  });

  // Lobby endpoint: dashboard clients subscribe to a session (authenticated)
  lobbyWss = new WebSocketServer({
    server,
    path: '/lobby',
    maxPayload: MAX_PAYLOAD_BYTES,
    verifyClient: (info: VerifyInfo, cb) => {
      const result = verifyWsRequest(info, auth);
      if (result === null) {
        logger.warn('Rejected unauthenticated /lobby WebSocket upgrade', {
          remoteAddress: info.req.socket.remoteAddress,
        });
        cb(false, 401, 'Unauthorized');
        return;
      }
      cb(true);
    },
  });
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
    ws.on('error', () => {
      subs?.delete(ws);
      if (subs?.size === 0) sessions.delete(sessionId);
    });
  });
}
