import { WebSocketServer, WebSocket } from 'ws';
import type { Server, IncomingMessage } from 'node:http';
import { type AuthConfig } from '../auth.js';
import { createLogger } from '../../logger/pino-logger.js';
import { verifyWsRequest } from '../ws-auth.js';

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
 *
 * SECURITY NOTE on the `?token=` fallback: the query string is captured by
 * upstream reverse proxies (nginx ingress) in their default access log format,
 * which persists the JWT in log aggregators (Loki/Promtail) beyond the token
 * lifetime. Prefer the `Sec-WebSocket-Protocol` path for all clients that can
 * set headers (browsers, programmatic clients with a custom-header API). The
 * `?token=` path is a last-resort fallback for clients that cannot set the
 * subprotocol header. When `?token=` is used we emit a `logger.warn` (without
 * the token value) so operators can detect reliance on this path and either
 * migrate the client to the subprotocol header or configure the ingress to
 * scrub `token` from the log line.
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

/** Attach stream WebSocket handlers to an existing HTTP server. */
export function attachStreamWs(server: Server, auth: AuthConfig): void {
  // Runner endpoint: runners connect here (authenticated)
  runnerWss = new WebSocketServer({
    server,
    path: '/runner',
    maxPayload: MAX_PAYLOAD_BYTES,
    verifyClient: (info: VerifyInfo, cb) => {
      const result = verifyWsRequest(info, auth, { useQueryToken: true });
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
      const result = verifyWsRequest(info, auth, { useQueryToken: true });
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
