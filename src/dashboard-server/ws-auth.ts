import type { IncomingMessage } from 'node:http';
import { verifyToken, type AuthConfig } from './auth.js';
import { createLogger } from '../logger/pino-logger.js';

const logger = createLogger('ai-arena:ws-auth');

export interface WsPrincipal { sub: string; role: string; }
export interface VerifyWsInfo {
  req: IncomingMessage;
}

/**
 * Verify a WebSocket upgrade request via the Sec-WebSocket-Protocol header
 * (the dashboard convention), optionally falling back to a `?token=` query
 * parameter. Returns the verified principal or `null` to reject the upgrade.
 */
export function verifyWsRequest(
  info: VerifyWsInfo,
  auth: AuthConfig,
  opts: { useQueryToken?: boolean } = {},
): WsPrincipal | null {
  const protocols = String(info.req.headers['sec-websocket-protocol'] ?? '');
  const protocolToken = protocols
    .split(',')
    .map((p) => p.trim())
    .find((p) => p !== 'access_token' && p.length > 0);
  if (protocolToken) {
    return verifyToken(auth, protocolToken);
  }

  if (opts.useQueryToken) {
    try {
      const url = new URL(info.req.url ?? '/', 'http://localhost');
      const queryToken = url.searchParams.get('token');
      if (queryToken) {
        logger.warn(
          'WebSocket auth used the ?token= query fallback — this JWT may be ' +
          'captured in upstream reverse-proxy access logs. Migrate the client ' +
          'to the Sec-WebSocket-Protocol header path if possible.',
          { path: url.pathname, remoteAddress: info.req.socket.remoteAddress },
        );
        return verifyToken(auth, queryToken);
      }
    } catch {
      // malformed URL — fall through to reject
    }
  }

  return null;
}
