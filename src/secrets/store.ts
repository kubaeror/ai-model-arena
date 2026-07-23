import fs from 'node:fs';
import path from 'node:path';
import { isKubernetes } from '../env/detect.js';

const SECRETS_DIR = '/etc/arena/secrets';
const SENSITIVE_KEYS = /(api.?key|secret|password|token|auth|credential)/i;

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
  private static _instance: SecretStore;

  static get instance(): SecretStore {
    if (!this._instance) this._instance = new SecretStore();
    return this._instance;
  }

  /**
   * Read a single secret value. In k8s mode, reads from filesystem-mount.
   * In bare-metal mode, reads from process.env.
   */
  get(envVar: string): string | undefined {
    if (isKubernetes()) {
      const filePath = path.join(SECRETS_DIR, envVar);
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
    if (isKubernetes()) {
      try {
        const files = fs.readdirSync(SECRETS_DIR);
        for (const f of files) {
          const full = path.join(SECRETS_DIR, f);
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
    if (isKubernetes()) {
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
    if (isKubernetes()) {
      throw new Error('SecretStore.delete() requires k8s API — use dashboard API endpoint');
    }
    delete process.env[envVar];
    await this.removeFromEnvFile(envVar);
  }

  private async writeEnvFile(key: string, value: string): Promise<void> {
    const envPath = path.join(process.cwd(), '.env');
    const escaped = value.replace(/"/g, '\\"');
    const line = `${key}="${escaped}"\n`;
    try {
      let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : '';
      const re = new RegExp(`^${key}=.*$`, 'm');
      if (re.test(content)) {
        content = content.replace(re, line.trim());
      } else {
        content = content.trimEnd() + '\n' + line;
      }
      fs.writeFileSync(envPath, content);
    } catch (err) {
      throw new Error(`Failed to write .env: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async removeFromEnvFile(key: string): Promise<void> {
    const envPath = path.join(process.cwd(), '.env');
    try {
      if (!fs.existsSync(envPath)) return;
      let content = fs.readFileSync(envPath, 'utf-8');
      const re = new RegExp(`^${key}=.*$`, 'm');
      content = content.replace(re, '').replace(/\n{2,}/g, '\n').trim();
      fs.writeFileSync(envPath, content + '\n');
    } catch (err) {
      throw new Error(`Failed to update .env: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

export const secretStore = SecretStore.instance;
