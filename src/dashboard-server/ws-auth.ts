import type { IncomingMessage } from 'node:http';
import { verifyToken, isRevoked, RedisUnavailableError, type AuthConfig } from './auth.js';
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
 *
 * Revocation is checked exactly like requireAuth (fail-closed on Redis
 * outage): a token revoked via logout must not keep working over WS until
 * natural expiry.
 */
export async function verifyWsRequest(
  info: VerifyWsInfo,
  auth: AuthConfig,
  opts: { useQueryToken?: boolean } = {},
): Promise<WsPrincipal | null> {
  const protocols = String(info.req.headers['sec-websocket-protocol'] ?? '');
  const protocolToken = protocols
    .split(',')
    .map((p) => p.trim())
    .find((p) => p !== 'access_token' && p.length > 0);
  let token = protocolToken ?? null;

  if (!token && opts.useQueryToken) {
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
        token = queryToken;
      }
    } catch {
      // malformed URL — fall through to reject
    }
  }

  if (!token) return null;
  const principal = verifyToken(auth, token);
  if (!principal) return null;
  // Fail-closed revocation check, mirroring requireAuth: a Redis outage must
  // not let a revoked token through.
  try {
    if (await isRevoked(token)) {
      logger.warn('Rejected WebSocket upgrade with revoked token', { sub: principal.sub });
      return null;
    }
  } catch (e) {
    if (e instanceof RedisUnavailableError) {
      logger.error('Revocation service unavailable — rejecting WebSocket upgrade', { error: e.message });
      return null;
    }
    throw e;
  }
  return principal;
}
