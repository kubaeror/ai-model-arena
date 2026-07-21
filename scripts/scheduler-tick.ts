import { tickScheduler } from '../src/scheduler/tick.js';
import { initDb } from '../src/db/client.js';
import { dbPath } from '../src/paths.js';

initDb(dbPath());
await tickScheduler();
console.log('Scheduler tick complete.');
