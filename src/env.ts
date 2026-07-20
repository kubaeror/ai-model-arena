import { z } from 'zod';

const EnvSchema = z.object({
  DASHBOARD_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  DASHBOARD_USERNAME: z.string().default('admin'),
  DASHBOARD_PASSWORD: z.string().min(1).optional(),
  DASHBOARD_JWT_SECRET: z.string().min(32, {
    message: 'DASHBOARD_JWT_SECRET must be at least 32 characters. ' +
             'Generate: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
  }),
  DASHBOARD_JWT_EXPIRES_IN: z.string().default('12h'),
  DASHBOARD_CORS_ORIGIN: z.string().default(''),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  OTEL_ENABLED: z.string().default('true'),
  OTEL_CAPTURE_CONTENT: z.string().default('false'),
});

export type Env = z.infer<typeof EnvSchema>;

// Throws at import time with a clear message if required vars are missing.
export const env = EnvSchema.parse(process.env);
