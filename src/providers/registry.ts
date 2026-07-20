import type { ProviderDescriptor } from './types.js';
import type { ModelAdapter } from './adapters/base.js';
import { OpenAICompatAdapter } from './adapters/openai-compat.js';
import { AnthropicAdapter } from './adapters/anthropic.js';
import { GoogleAdapter } from './adapters/google.js';
import { BedrockAdapter } from './adapters/bedrock.js';
import type { Database } from 'better-sqlite3';
import type { ProviderRow } from '../db/schema.js';

export interface CreateAdapterOpts {
  apiKey?: string;
  logger?: import('../types.js').Logger;
  baseUrl?: string;
}

const ADAPTER_CLASSES = {
  'openai-compat': OpenAICompatAdapter,
  'anthropic': AnthropicAdapter,
  'google': GoogleAdapter,
  'bedrock': BedrockAdapter,
} as const;

export class ProviderRegistry {
  private descriptors = new Map<string, ProviderDescriptor>();

  register(d: ProviderDescriptor): void { this.descriptors.set(d.id, d); }
  list(): ProviderDescriptor[] { return [...this.descriptors.values()]; }
  get(id: string): ProviderDescriptor | undefined { return this.descriptors.get(id); }

  createAdapter(providerId: string, modelId: string, opts: CreateAdapterOpts): ModelAdapter {
    const d = this.descriptors.get(providerId);
    if (!d) throw new Error(`Unknown provider: ${providerId}`);
    const AdapterClass = ADAPTER_CLASSES[d.adapter];
    if (!AdapterClass) throw new Error(`Unknown adapter kind: ${d.adapter}`);
    return new AdapterClass(d, modelId, opts);
  }

  loadBuiltins(descriptors: ProviderDescriptor[]): void {
    for (const d of descriptors) this.register(d);
  }

  loadCustomFromDb(db: Database): void {
    const rows = db.prepare('SELECT * FROM providers WHERE is_builtin = 0').all() as ProviderRow[];
    for (const r of rows) {
      this.register({
        id: r.id, name: r.name, apiBase: r.api_base ?? undefined,
        authScheme: r.auth_scheme, envVar: r.env_var ?? undefined,
        headerName: r.header_name ?? undefined, adapter: r.adapter, isBuiltin: false,
      });
    }
  }
}
