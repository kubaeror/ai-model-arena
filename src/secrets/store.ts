import fs from 'node:fs';
import path from 'node:path';
import { isKubernetes } from '../env/detect.js';

const SECRETS_DIR = '/etc/arena/secrets';
const SENSITIVE_KEYS = /(api.?key|secret|password|token|auth|credential)/i;
const K8S_SECRET_FILE_RE = /^[A-Za-z0-9_]+$/;

export interface SecretStoreOptions {
  /** Bare-metal .env path (default: <cwd>/.env). */
  envFile?: string;
  /** k8s secrets mount dir (default: /etc/arena/secrets). */
  secretsDir?: string;
  /** Platform override for tests (default: auto-detect). */
  platform?: 'kubernetes' | 'bare-metal';
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface SecretEntry {
  envVar: string;
  status: 'set' | 'missing';
  maskedValue?: string;
}

function mask(v: string): string {
  if (v.length <= 4) return '****';
  return v.slice(0, 4) + '...' + v.slice(-4);
}

export class SecretStore {
  private readonly envFile: string;
  private readonly secretsDir: string;
  private readonly platform: 'kubernetes' | 'bare-metal';

  private static _instance: SecretStore;

  constructor(options: SecretStoreOptions = {}) {
    this.envFile = options.envFile ?? path.join(process.cwd(), '.env');
    this.secretsDir = options.secretsDir ?? SECRETS_DIR;
    this.platform = options.platform ?? (isKubernetes() ? 'kubernetes' : 'bare-metal');
  }

  private isK8s(): boolean {
    return this.platform === 'kubernetes';
  }

  static get instance(): SecretStore {
    if (!this._instance) this._instance = new SecretStore();
    return this._instance;
  }

  /**
   * Read a single secret value. In k8s mode, reads from filesystem-mount.
   * In bare-metal mode, reads from process.env.
   */
  get(envVar: string): string | undefined {
    if (this.isK8s()) {
      const filePath = path.join(this.secretsDir, envVar);
      try {
        return fs.readFileSync(filePath, 'utf-8').trim();
      } catch {
        return undefined;
      }
    }
    return process.env[envVar] ?? undefined;
  }

  /**
   * List all known provider secrets with masked values.
   */
  list(): SecretEntry[] {
    const entries: SecretEntry[] = [];
    if (this.isK8s()) {
      try {
        const files = fs.readdirSync(this.secretsDir);
        for (const f of files) {
          if (!K8S_SECRET_FILE_RE.test(f)) continue;
          const full = path.join(this.secretsDir, f);
          if (fs.statSync(full).isFile()) {
            const v = fs.readFileSync(full, 'utf-8').trim();
            entries.push({ envVar: f, status: v ? 'set' : 'missing', maskedValue: mask(v) });
          }
        }
      } catch {
        // directory doesn't exist yet
      }
    } else {
      for (const [k, v] of Object.entries(process.env)) {
        if (SENSITIVE_KEYS.test(k)) {
          entries.push({ envVar: k, status: v ? 'set' : 'missing', maskedValue: v ? mask(v) : undefined });
        }
      }
    }
    return entries;
  }

  /**
   * Set a secret value. In k8s mode, does nothing — mutations happen via
   * the dashboard API patching the k8s Secret resource, which auto-refreshes
   * the filesystem mount via kubelet.
   * In bare-metal mode, writes to .env file and sets process.env.
   */
  async set(envVar: string, value: string): Promise<void> {
    if (this.isK8s()) {
      throw new Error('SecretStore.set() requires k8s API — use dashboard API endpoint');
    }
    // Bare-metal: write to .env
    process.env[envVar] = value;
    await this.writeEnvFile(envVar, value);
  }

  /**
   * Delete a secret. In k8s mode, same constraint as set().
   */
  async delete(envVar: string): Promise<void> {
    if (this.isK8s()) {
      throw new Error('SecretStore.delete() requires k8s API — use dashboard API endpoint');
    }
    delete process.env[envVar];
    await this.removeFromEnvFile(envVar);
  }

  private async writeEnvFile(key: string, value: string): Promise<void> {
    const escaped = value.replace(/"/g, '\\"');
    const line = `${key}="${escaped}"\n`;
    try {
      let content = fs.existsSync(this.envFile) ? fs.readFileSync(this.envFile, 'utf-8') : '';
      const re = new RegExp(`^${escapeRegex(key)}=.*$`, 'm');
      if (re.test(content)) {
        content = content.replace(re, line.trim());
      } else {
        content = content.trimEnd() + '\n' + line;
      }
      fs.writeFileSync(this.envFile, content);
    } catch (err) {
      throw new Error(`Failed to write .env: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async removeFromEnvFile(key: string): Promise<void> {
    try {
      if (!fs.existsSync(this.envFile)) return;
      let content = fs.readFileSync(this.envFile, 'utf-8');
      const re = new RegExp(`^${escapeRegex(key)}=.*$`, 'm');
      content = content.replace(re, '').replace(/\n{2,}/g, '\n').trim();
      fs.writeFileSync(this.envFile, content + '\n');
    } catch (err) {
      throw new Error(`Failed to update .env: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

export const secretStore = SecretStore.instance;
