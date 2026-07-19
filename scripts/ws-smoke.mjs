// Quick WebSocket smoke test for the dashboard gateway.
//   node scripts/ws-smoke.mjs <jwt>
// Connects, expects a process_status event, prints it, exits 0.
import WebSocket from 'ws';

const token = process.argv[2];
if (!token) { console.error('Usage: node scripts/ws-smoke.mjs <jwt>'); process.exit(2); }

const url = `ws://localhost:${process.env.DASHBOARD_PORT ?? 4010}/ws?token=${encodeURIComponent(token)}`;
const ws = new WebSocket(url);
const timer = setTimeout(() => { console.error('TIMEOUT: no message received'); process.exit(1); }, 8000);

ws.on('open', () => console.log('WS: connected'));
ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  console.log(`WS event: ${msg.type}`);
  if (msg.type === 'process_status') {
    console.log(`  processes: ${(msg.processes ?? []).length}`);
    clearTimeout(timer);
    setTimeout(() => { ws.close(); process.exit(0); }, 300);
  }
});
ws.on('error', (e) => { console.error('WS error:', e.message); process.exit(1); });
