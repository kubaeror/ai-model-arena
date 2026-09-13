import type { ProviderDescriptor } from './types.js';
import type { ModelAdapter } from './adapters/base.js';
import { OpenAICompatAdapter } from './adapters/openai-compat.js';
import { AnthropicAdapter } from './adapters/anthropic.js';
import { GoogleAdapter } from './adapters/google.js';
import { BedrockAdapter } from './adapters/bedrock.js';
import { validateProviderUrl } from './url-validator.js';

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
    
    // Re-validate custom provider URLs on every adapter construction
    // (SSRF defense: a previously safe URL could have been modified in DB)
    if (!d.isBuiltin && d.apiBase) {
      const validation = validateProviderUrl(d.apiBase);
      if (!validation.ok) {
        throw new Error(`Provider "${providerId}" URL failed re-validation: ${validation.error}`);
      }
    }
    
    const AdapterClass = ADAPTER_CLASSES[d.adapter];
    if (!AdapterClass) throw new Error(`Unknown adapter kind: ${d.adapter}`);
    return new AdapterClass(d, modelId, opts);
  }

  loadBuiltins(descriptors: ProviderDescriptor[]): void {
    for (const d of descriptors) this.register(d);
  }

  /**
   * Merge every DB-backed provider (custom and catalog-synced) into the
   * registry. Descriptors registered earlier — i.e. the static builtins — win
   * on id conflicts.
   */
  async loadCustomFromDb(): Promise<void> {
    const { listAllProviders } = await import('./custom.js');
    const rows = await listAllProviders();
    for (const r of rows) {
      // Static descriptors are registered first and win on id conflicts, so
      // neither user custom rows nor catalog-synced rows shadow a builtin.
      if (this.descriptors.has(r.id)) continue;
      this.register({
        id: r.id, name: r.name, apiBase: r.api_base ?? undefined,
        authScheme: r.auth_scheme, envVar: r.env_var ?? undefined,
        headerName: r.header_name ?? undefined, adapter: r.adapter,
        // DB-backed URLs are untrusted input (catalog URLs come from remote
        // JSON), so createAdapter re-validates them on every construction.
        isBuiltin: false,
      });
    }
  }
}
