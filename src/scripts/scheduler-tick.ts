import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { tickScheduler } from '../scheduler/tick.js';
import { initDb } from '../db/index.js';
import { closeDb } from '../db/index.js';
import { loadSchedulesConfig } from '../scheduler/manager.js';
import { findProjectRoot } from '../paths.js';

export function schedulesPath(): string {
  return process.env.SCHEDULES_PATH ?? path.join(findProjectRoot(), 'configs', 'schedules.yaml');
}

export async function runSchedulerTick(opts?: Parameters<typeof tickScheduler>[0]): Promise<void> {
  initDb();
  loadSchedulesConfig(schedulesPath());
  await tickScheduler(opts);
  await closeDb();
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  await runSchedulerTick();
  console.error('Scheduler tick complete.');
}
