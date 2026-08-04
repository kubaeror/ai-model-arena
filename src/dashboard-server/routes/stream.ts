import { WebSocketServer, WebSocket } from 'ws';
import type { Server, IncomingMessage } from 'node:http';
import { type AuthConfig } from '../auth.js';
import { createLogger } from '../../logger/pino-logger.js';
import { verifyWsRequest } from '../ws-auth.js';
import { getRunRecord } from '../../orchestrator/run-index.js';

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
const MAX_CONNECTIONS = 200; // per endpoint — no unlimited authenticated sockets

const sessions = new Map<string, Set<WebSocket>>();
const runnerSockets = new Set<WebSocket>();

let runnerWss: WebSocketServer | null = null;
let lobbyWss: WebSocketServer | null = null;

const logger = createLogger('ai-arena:stream');

interface VerifyInfo {
  req: IncomingMessage;
}

/** Strip a model suffix from a session id to recover the run id. */
async function runIdFromSessionId(sessionId: string): Promise<string | null> {
  // sessionId is `${runId}-${model}`; runId itself may contain dashes, so
  // progressively strip trailing `-<segment>` until a run record matches.
  let candidate = sessionId;
  for (let i = 0; i < 5; i++) {
    const rec = await getRunRecord(candidate).catch(() => null);
    if (rec) return candidate;
    const idx = candidate.lastIndexOf('-');
    if (idx <= 0) return null;
    candidate = candidate.slice(0, idx);
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
      void (async () => {
        if (runnerWss && runnerWss.clients.size >= MAX_CONNECTIONS) {
          logger.warn('Rejected /runner upgrade: connection cap reached');
          cb(false, 503, 'Too many connections');
          return;
        }
        const principal = await verifyWsRequest(info, auth, { useQueryToken: true });
        (info.req as IncomingMessage & { _wsUser?: { sub: string; role: string } })._wsUser = principal ?? undefined;
        if (principal === null) {
          logger.warn('Rejected unauthenticated /runner WebSocket upgrade', {
            remoteAddress: info.req.socket.remoteAddress,
          });
          cb(false, 401, 'Unauthorized');
          return;
        }
        if (principal.role !== 'admin') {
          logger.warn('Rejected non-admin /runner WebSocket upgrade', {
            sub: principal.sub,
            remoteAddress: info.req.socket.remoteAddress,
          });
          cb(false, 403, 'Forbidden');
          return;
        }
        cb(true);
      })();
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
      void (async () => {
        if (lobbyWss && lobbyWss.clients.size >= MAX_CONNECTIONS) {
          logger.warn('Rejected /lobby upgrade: connection cap reached');
          cb(false, 503, 'Too many connections');
          return;
        }
        const principal = await verifyWsRequest(info, auth, { useQueryToken: true });
        if (principal === null) {
          logger.warn('Rejected unauthenticated /lobby WebSocket upgrade', {
            remoteAddress: info.req.socket.remoteAddress,
          });
          cb(false, 401, 'Unauthorized');
          return;
        }
        (info.req as IncomingMessage & { _wsUser?: { sub: string; role: string } })._wsUser = principal;
        cb(true);
      })();
    },
  });
  lobbyWss.on('connection', (ws, req) => {
    const user = (req as IncomingMessage & { _wsUser?: { sub: string; role: string } })._wsUser ?? { sub: 'unknown', role: 'viewer' };
    const url = new URL(req.url ?? '/', 'http://localhost');
    const sessionId = url.searchParams.get('sessionId');
    if (!sessionId) { ws.close(4000, 'Missing sessionId query parameter'); return; }

    // Ownership gate: viewers may only subscribe to their own runs; a run
    // with no createdBy (legacy) is default-DENY for non-admins. Prevents
    // reading another tenant's relayed runner messages by sessionId.
    void (async () => {
      const runId = await runIdFromSessionId(sessionId);
      const rec = runId ? await getRunRecord(runId).catch(() => null) : null;
      const isAdmin = user.role === 'admin';
      const ownerIsPresent = typeof rec?.createdBy === 'string' && rec.createdBy.length > 0;
      const allowed = isAdmin || (ownerIsPresent && user.sub === rec!.createdBy);
      if (!allowed) {
        logger.warn('Rejected /lobby subscribe: not the run owner', { sub: user.sub, sessionId });
        ws.close(4003, 'Forbidden: not the run owner');
        return;
      }

      let subs = sessions.get(sessionId);
      if (!subs) { subs = new Set(); sessions.set(sessionId, subs); }
      subs.add(ws);
    })();

    ws.on('close', () => {
      const subs = sessions.get(sessionId);
      subs?.delete(ws);
      if (subs?.size === 0) sessions.delete(sessionId);
    });
    ws.on('error', () => {
      const subs = sessions.get(sessionId);
      subs?.delete(ws);
      if (subs?.size === 0) sessions.delete(sessionId);
    });
  });
}
