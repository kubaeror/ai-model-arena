export interface AdmissionConfig {
  globalMaxConcurrency: number;
  perProviderLimits: Record<string, number>;
  perModelLimits: Record<string, number>;
  maxQueueDepth: number;
}

const defaultConfig: AdmissionConfig = {
  globalMaxConcurrency: 50,
  perProviderLimits: {},
  perModelLimits: {},
  maxQueueDepth: 500,
};

let config: AdmissionConfig | null = null;

const activeCounts = new Map<string, number>();

export function loadAdmissionConfig(cfg?: Partial<AdmissionConfig>): void {
  config = { ...defaultConfig, ...cfg };
}

export function getAdmissionConfig(): AdmissionConfig {
  return config ?? defaultConfig;
}

/** Check if a new task can be admitted. Returns {ok: true} or {ok: false, reason}. */
export function checkAdmission(provider: string, model: string, currentQueueSize: number): { ok: boolean; reason?: string } {
  const cfg = getAdmissionConfig();

  if (currentQueueSize >= cfg.maxQueueDepth) {
    return { ok: false, reason: `Queue depth ${currentQueueSize} exceeds max ${cfg.maxQueueDepth}` };
  }

  const globalCount = activeCounts.get('*') ?? 0;
  if (globalCount >= cfg.globalMaxConcurrency) {
    return { ok: false, reason: `Global concurrency limit ${cfg.globalMaxConcurrency} reached` };
  }

  const providerLimit = cfg.perProviderLimits[provider];
  if (providerLimit) {
    const providerCount = activeCounts.get(`p:${provider}`) ?? 0;
    if (providerCount >= providerLimit) {
      return { ok: false, reason: `Provider concurrency limit ${providerLimit} reached for ${provider}` };
    }
  }

  const modelLimit = cfg.perModelLimits[model];
  if (modelLimit) {
    const modelCount = activeCounts.get(`m:${model}`) ?? 0;
    if (modelCount >= modelLimit) {
      return { ok: false, reason: `Model concurrency limit ${modelLimit} reached for ${model}` };
    }
  }

  return { ok: true };
}

/** Increment active counts when a task starts. Call before dispatching. */
export function admitTask(provider: string, model: string): void {
  activeCounts.set('*', (activeCounts.get('*') ?? 0) + 1);
  activeCounts.set(`p:${provider}`, (activeCounts.get(`p:${provider}`) ?? 0) + 1);
  activeCounts.set(`m:${model}`, (activeCounts.get(`m:${model}`) ?? 0) + 1);
}

/** Decrement active counts when a task completes. Call on ack/nack. */
export function releaseTask(provider: string, model: string): void {
  for (const key of ['*', `p:${provider}`, `m:${model}`]) {
    const v = activeCounts.get(key);
    if (v !== undefined && v > 0) activeCounts.set(key, v - 1);
  }
}
