import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from '../types.js';
import { sandboxEnv } from './sandbox.js';

const execFile = promisify(execFileCallback);

export interface GitOptions {
  sandboxDir: string;
  modelName: string;
  logger?: Logger;
}

export class SandboxGit {
  private sandboxDir: string;
  private modelName: string;
  private logger?: Logger;
  private initialized: boolean = false;
  private initialCommitHash: string | null = null;
  
  constructor(opts: GitOptions) {
    this.sandboxDir = opts.sandboxDir;
    this.modelName = opts.modelName;
    this.logger = opts.logger;
  }
  
  private async git(args: string[]): Promise<{ stdout: string; stderr: string }> {
    this.logger?.debug('Running git command', { args });
    const result = await execFile('git', args, {
      cwd: this.sandboxDir,
      env: {
        ...sandboxEnv(),
        GIT_AUTHOR_NAME: `ai-arena:${this.modelName}`,
        GIT_AUTHOR_EMAIL: `ai-arena-${this.modelName}@localhost`,
        GIT_COMMITTER_NAME: `ai-arena:${this.modelName}`,
        GIT_COMMITTER_EMAIL: `ai-arena-${this.modelName}@localhost`,
      },
    });
    return result;
  }
  
  async init(): Promise<void> {
    if (this.initialized) return;
    
    if (!fs.existsSync(this.sandboxDir)) {
      fs.mkdirSync(this.sandboxDir, { recursive: true });
    }
    
    const gitDir = path.join(this.sandboxDir, '.git');
    if (!fs.existsSync(gitDir)) {
      await this.git(['init']);
      this.logger?.info('Initialized git repo in sandbox', { dir: this.sandboxDir });
    }
    
    try {
      await this.git(['config', 'user.name', 'ai-arena-bot']);
      await this.git(['config', 'user.email', 'ai-arena@localhost']);
    } catch {}
    
    const files = fs.readdirSync(this.sandboxDir).filter(f => f !== '.git');
    if (files.length > 0) {
      await this.git(['add', '-A']);
      try {
        await this.git(['commit', '-m', 'Initial commit (starter files)', '--allow-empty-message']);
      } catch {}
    } else {
      await this.git(['commit', '--allow-empty', '-m', 'Initial commit (empty sandbox)']);
    }
    
    const result = await this.git(['rev-parse', 'HEAD']);
    this.initialCommitHash = result.stdout.trim();
    this.initialized = true;
    this.logger?.info('Created initial commit', { hash: this.initialCommitHash });
  }
  
  async commitTurn(turnNumber: number, summary: string): Promise<string | null> {
    if (!this.initialized) return null;
    
    const shortSummary = summary.slice(0, 80).replace(/\n/g, ' ');
    const message = `[${this.modelName}] turn ${turnNumber}: ${shortSummary}`;
    
    try {
      await this.git(['add', '-A']);
      const status = await this.git(['status', '--porcelain']);
      if (!status.stdout.trim()) {
        this.logger?.debug('No changes to commit', { turn: turnNumber });
        return null;
      }
      await this.git(['commit', '-m', message]);
      const result = await this.git(['rev-parse', 'HEAD']);
      const hash = result.stdout.trim();
      this.logger?.info('Committed turn changes', { turn: turnNumber, hash });
      return hash;
    } catch (err) {
      this.logger?.warn('Failed to commit turn', { turn: turnNumber, error: String(err) });
      return null;
    }
  }
  
  async commitFinal(summary: string): Promise<string | null> {
    if (!this.initialized) return null;
    
    const shortSummary = summary.slice(0, 100).replace(/\n/g, ' ');
    const message = `[${this.modelName}] run complete: ${shortSummary}`;
    
    try {
      await this.git(['add', '-A']);
      const status = await this.git(['status', '--porcelain']);
      if (!status.stdout.trim()) {
        return null;
      }
      await this.git(['commit', '-m', message]);
      const result = await this.git(['rev-parse', 'HEAD']);
      return result.stdout.trim();
    } catch (err) {
      this.logger?.warn('Failed to commit final state', { error: String(err) });
      return null;
    }
  }
  
  async generateDiff(): Promise<string> {
    if (!this.initialized || !this.initialCommitHash) {
      return '';
    }
    
    try {
      const result = await this.git(['diff', this.initialCommitHash!, 'HEAD']);
      return result.stdout;
    } catch (err) {
      this.logger?.warn('Failed to generate diff', { error: String(err) });
      return '';
    }
  }
  
  async getLog(): Promise<Array<{ hash: string; message: string; author: string; date: string }>> {
    if (!this.initialized) return [];
    
    try {
      const result = await this.git(['log', '--pretty=format:%H|%s|%an|%cd', '--date=iso']);
      return result.stdout.trim().split('\n').filter(Boolean).map(line => {
        const parts = line.split('|');
        return {
          hash: parts[0] ?? '',
          message: parts[1] ?? '',
          author: parts[2] ?? '',
          date: parts[3] ?? '',
        };
      });
    } catch {
      return [];
    }
  }
  
  getInitialCommitHash(): string | null {
    return this.initialCommitHash;
  }
}

export async function writeDiffPatch(outputDir: string, diff: string, logger?: Logger): Promise<string | null> {
  if (!diff) return null;
  
  const patchPath = path.join(outputDir, 'diff.patch');
  fs.writeFileSync(patchPath, diff);
  logger?.info('Wrote diff.patch', { path: patchPath });
  return patchPath;
}

export async function readDiffPatch(outputDir: string): Promise<string | null> {
  const patchPath = path.join(outputDir, 'diff.patch');
  try {
    return await fs.promises.readFile(patchPath, 'utf8');
  } catch {
    return null;
  }
}
