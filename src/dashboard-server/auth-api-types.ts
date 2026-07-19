import { z } from 'zod';

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

export type ApiKeyPermission = z.infer<typeof ApiKeyPermissionSchema>;
export type ApiKey = z.infer<typeof ApiKeySchema>;
export type ApiKeysConfig = z.infer<typeof ApiKeysConfigSchema>;

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
