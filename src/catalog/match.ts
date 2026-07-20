export function normalizeModelId(modelId: string, providerId: string): string {
  return `${providerId}/${modelId}`;
}

export interface CatalogEntry {
  id: string;
  name: string;
  provider_id: string;
}

export function matchModelToCanonical(
  apiModelId: string | undefined,
  providerId: string | undefined,
  catalog: CatalogEntry[],
  nameHint?: string,
): string | null {
  if (apiModelId && providerId) {
    const direct = normalizeModelId(apiModelId, providerId);
    if (catalog.some(c => c.id === direct)) return direct;
  }
  if (nameHint) {
    const normalized = nameHint.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    for (const entry of catalog) {
      const entryName = entry.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      if (entryName === normalized) return entry.id;
      if (entryName.includes(normalized) || normalized.includes(entryName)) return entry.id;
    }
  }
  return null;
}
