import crypto from 'node:crypto';
import { createLogger } from '../logger/pino-logger.js';

const logger = createLogger('ai-arena:webhook-secret-crypto');

/**
 * AES-256-GCM encryption for webhook HMAC secrets at rest.
 *
 * Webhook secrets are used to sign outbound webhook deliveries
 * (x-arena-signature). Stored in plaintext in the webhooks table, they were
 * readable by anyone with DB read access (or via the S5 regression
 * path-traversal before that fix). Encrypt them at rest with AES-256-GCM
 * keyed by WEBHOOK_SECRET_KEY.
 *
 * Ciphertext format: `v1:<base64(iv|ciphertext|authTag)>`
 *   - v1: version prefix for future migration.
 *   - iv: 12-byte GCM nonce (unique per encryption).
 *   - ciphertext: same length as plaintext.
 *   - authTag: 16-byte GCM authentication tag (tamper detection).
 *
 * Backward compatibility: values without the `v1:` prefix are treated as
 * legacy plaintext (pre-encryption rows). getWebhookSecret() returns them
 * as-is so existing rows keep working until re-saved by the operator.
 *
 * Key source (WEBHOOK_SECRET_KEY):
 *   - 32 bytes, hex (64 chars) or base64 (44 chars) encoded.
 *   - In production (NODE_ENV=production): MUST be set. If unset,
 *     encrypt/decrypt throw — fail-closed.
 *   - In dev: if unset, a deterministic dev key is derived from a fixed
 *     salt so encrypted secrets remain readable across dev restarts. This
 *     is NOT secure for production; the hard-fail above forces operators
 *     to set it.
 */

const VERSION_PREFIX = 'v1:';
const GCM_ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const KEY_BYTES = 32;

let cachedKey: Buffer | null = null;
let cachedKeySource: 'env' | 'dev-derived' | null = null;

function deriveDevKey(): Buffer {
  // Deterministic dev-only key derived from a fixed salt. NOT secure for
  // production — production must set WEBHOOK_SECRET_KEY.
  const salt = 'ai-arena-dev-webhook-key-do-not-use-in-prod';
  return crypto.scryptSync('ai-arena-dev', salt, KEY_BYTES);
}

function getKey(): { key: Buffer; source: 'env' | 'dev-derived' } {
  if (cachedKey && cachedKeySource) return { key: cachedKey, source: cachedKeySource };
  const envKey = process.env.WEBHOOK_SECRET_KEY;
  if (envKey) {
    let key: Buffer;
    // Accept hex (64 chars = 32 bytes) or base64 (44 chars incl. padding).
    if (/^[0-9a-fA-F]{64}$/.test(envKey)) {
      key = Buffer.from(envKey, 'hex');
    } else {
      key = Buffer.from(envKey, 'base64');
    }
    if (key.length !== KEY_BYTES) {
      throw new Error(
        `WEBHOOK_SECRET_KEY must decode to exactly ${KEY_BYTES} bytes (got ${key.length}). ` +
        `Provide 64 hex chars or 44 base64 chars.`,
      );
    }
    cachedKey = key;
    cachedKeySource = 'env';
    return { key, source: 'env' };
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'WEBHOOK_SECRET_KEY is not set and NODE_ENV=production. Refusing to ' +
      'encrypt/decrypt webhook secrets without a configured key. Generate ' +
      'one: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))" ' +
      'and set WEBHOOK_SECRET_KEY in your environment (load it from a secret ' +
      'in k8s).',
    );
  }
  // Dev mode — derive a deterministic key.
  const key = deriveDevKey();
  cachedKey = key;
  cachedKeySource = 'dev-derived';
  logger.warn('WEBHOOK_SECRET_KEY not set — using a derived dev key. Do NOT use in production.');
  return { key, source: 'dev-derived' };
}

/**
 * Encrypt a webhook secret for at-rest storage.
 * @param plaintext - the HMAC secret to encrypt.
 * @returns the ciphertext string (`v1:<base64>`) or null if plaintext is null/empty.
 */
export function encryptWebhookSecret(plaintext: string | null | undefined): string | null {
  if (plaintext == null || plaintext === '') return null;
  const { key } = getKey();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(GCM_ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const blob = Buffer.concat([iv, ciphertext, authTag]);
  return VERSION_PREFIX + blob.toString('base64');
}

/**
 * Decrypt a webhook secret. Accepts both the `v1:`-prefixed ciphertext
 * (encrypted) and legacy plaintext (no prefix) for backward compatibility.
 * @param stored - the value from the DB (ciphertext or legacy plaintext).
 * @returns the plaintext secret, or null if stored is null/empty.
 */
export function decryptWebhookSecret(stored: string | null | undefined): string | null {
  if (stored == null || stored === '') return null;
  if (!stored.startsWith(VERSION_PREFIX)) {
    // Legacy plaintext (pre-encryption row). Return as-is so existing rows
    // keep working until the operator re-saves the secret.
    return stored;
  }
  const { key } = getKey();
  const blob = Buffer.from(stored.slice(VERSION_PREFIX.length), 'base64');
  if (blob.length < IV_BYTES + AUTH_TAG_BYTES) {
    throw new Error('Malformed webhook secret ciphertext (too short).');
  }
  const iv = blob.subarray(0, IV_BYTES);
  const authTag = blob.subarray(blob.length - AUTH_TAG_BYTES);
  const ciphertext = blob.subarray(IV_BYTES, blob.length - AUTH_TAG_BYTES);
  const decipher = crypto.createDecipheriv(GCM_ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  // setEncoding before update for string output
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}

/** Reset cached key (for tests). */
export function _resetKeyCacheForTests(): void {
  cachedKey = null;
  cachedKeySource = null;
}
