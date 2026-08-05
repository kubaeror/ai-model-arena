/**
 * Boot-time required env validation.
 *
 * Fail fast with a clear, aggregated list of missing variables instead of
 * letting each subsystem surface its own confusing error later in boot.
 *
 * Required vars are the ones with no safe default:
 *   - runner:  DB_DRIVER, QUEUE_DRIVER, OUTPUT_ROOT (+ DATABASE_URL when
 *              DB_DRIVER=postgres, + REDIS_URL when QUEUE_DRIVER=redis).
 *   - dashboard: DASHBOARD_JWT_SECRET, DB_DRIVER (+ DATABASE_URL when
 *              DB_DRIVER=postgres). DASHBOARD_PASSWORD is intentionally NOT
 *              required — auth.ts generates a one-time dev password (and
 *              hard-fails itself under NODE_ENV=production).
 *
 * Optional vars (JWT expiry, webhook secrets, etc.) never throw.
 *
 * Set ARENA_SKIP_ENV_CHECK=1 to bypass the check entirely (tests/CI).
 */

export type EnvScope = 'runner' | 'dashboard';

const REQUIRED_BY_SCOPE: Record<EnvScope, readonly string[]> = {
  runner: ['DB_DRIVER', 'QUEUE_DRIVER', 'OUTPUT_ROOT'],
  dashboard: ['DASHBOARD_JWT_SECRET', 'DB_DRIVER'],
};

/** Return the list of missing required env vars (empty when all present). */
export function missingRequiredEnv(scope: EnvScope): string[] {
  if (process.env.ARENA_SKIP_ENV_CHECK === '1') return [];

  const missing = REQUIRED_BY_SCOPE[scope].filter((name) => !process.env[name]);

  // Conditional requirements driven by driver selection — same defaults as
  // src/db/index.ts (sqlite) and src/queue/index.ts (memory), so a driver
  // that is unset never demands its URL.
  const dbDriver = (process.env.DB_DRIVER ?? '').toLowerCase();
  if (dbDriver === 'postgres' && !process.env.DATABASE_URL) {
    missing.push('DATABASE_URL');
  }
  if (
    scope === 'runner' &&
    (process.env.QUEUE_DRIVER ?? '').toLowerCase() === 'redis' &&
    !process.env.REDIS_URL
  ) {
    missing.push('REDIS_URL');
  }

  return missing;
}

/**
 * Assert the required env vars are present for the scope.
 *
 * @throws {Error} listing every missing variable.
 * @returns the (empty) list of missing vars when nothing is missing.
 */
export function assertRequiredEnv(scope: EnvScope): string[] {
  const missing = missingRequiredEnv(scope);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
  return missing;
}
