import fs from 'node:fs';
import path from 'node:path';

function tryLockFile(lockPath: string): boolean {
  try {
    const fd = fs.openSync(lockPath, 'wx');
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
    return true;
  } catch {
    return false;
  }
}

async function acquireLock(dir: string): Promise<() => void> {
  const lockPath = path.join(dir, '.lock');
  await fs.promises.mkdir(dir, { recursive: true });
  const interval = 20;
  const maxWait = 10000;
  let waited = 0;
  while (true) {
    if (tryLockFile(lockPath)) break;
    if (waited >= maxWait) throw new Error(`Could not acquire lock for ${dir} after ${maxWait}ms`);
    await new Promise(r => setTimeout(r, interval));
    waited += interval;
  }
  return () => { try { fs.unlinkSync(lockPath); } catch { /* */ } };
}

export async function lockedWrite(
  targetPath: string,
  content: string,
  opts: { lockDir: string; },
): Promise<void> {
  const release = await acquireLock(opts.lockDir);
  try {
    const staging = `${targetPath}.${process.pid}.tmp`;
    await fs.promises.writeFile(staging, content);
    await fs.promises.rename(staging, targetPath);
  } finally {
    release();
  }
}
