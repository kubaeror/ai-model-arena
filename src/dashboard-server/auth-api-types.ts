import { z } from 'zod';
import type { Request } from 'express';

export const ApiKeyPermissionSchema = z.enum([
  'runs:read',
  'runs:write',
  'models:read',
  'models:write',
  'scenarios:read',
  'scenarios:write',
  'analytics:read',
  'analytics:write',
  'export:read',
  'traces:read',
  'anomalies:read',
  'anomalies:write',
  'observability:read',
  'webhooks:write',
  'providers:read',
  'providers:write',
  'catalog:read',
  'metrics:read',
  'cache:read',
  'cache:write',
]);

export const ApiKeySchema = z.object({
  key: z.string(),
  name: z.string(),
  description: z.string().optional(),
  permissions: z.array(ApiKeyPermissionSchema).min(1),
  rateLimit: z.number().min(1).default(100),
});

export const ApiKeysConfigSchema = z.object({
  apiKeys: z.array(ApiKeySchema),
});

export type ApiKeyPermission = z.output<typeof ApiKeyPermissionSchema>;
export type ApiKey = z.output<typeof ApiKeySchema>;
export type ApiKeysConfig = z.output<typeof ApiKeysConfigSchema>;

export interface RequestContext {
  keyName: string;
  permissions: ApiKeyPermission[];
  rateLimit: number;
}

export interface RateLimitState {
  count: number;
  resetAt: number;
}

export interface ApiKeyRequest extends Request {
  apiKey?: RequestContext;
}

export function hasApiKeyPermission(req: Request, permission: ApiKeyPermission): boolean {
  return ((req as ApiKeyRequest).apiKey?.permissions ?? []).includes(permission);
}
