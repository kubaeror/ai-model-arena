import type { ProviderRegistry } from './registry.js';
import type { ProviderDescriptor } from './types.js';
import { DESCRIPTOR_SPECS } from './descriptors/data.js';

export const BUILTIN_PROVIDERS: ProviderDescriptor[] = [...DESCRIPTOR_SPECS];

export function loadBuiltins(reg: ProviderRegistry): void {
  reg.loadBuiltins(BUILTIN_PROVIDERS);
}

export { ProviderRegistry } from './registry.js';
