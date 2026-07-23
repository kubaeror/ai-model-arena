import { tickScheduler } from '../scheduler/tick.js';
import { initDb } from '../db/index.js';
import { closeDb } from '../db/index.js';

initDb();
await tickScheduler();
await closeDb();
console.error('Scheduler tick complete.');
