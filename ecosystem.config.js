// PM2 ecosystem configuration for ai-model-arena.
//
// The dashboard server runs as a long-lived, PM2-managed process. Start it with:
//   pm2 start ecosystem.config.js
// (PM2 >=5 supports ESM ecosystem files; the project is `"type": "module"`.)
//
// Worker processes (one per model per run) are NOT declared here. They are
// started DYNAMICALLY by the orchestrator (src/orchestrator/) via the PM2
// *programmatic* API, each with a unique name `ai-arena-<model>-<scenario>-<ts>`,
// because every run has a unique timestamped name. Their shape, for reference:
//
//   {
//     name: 'ai-arena-<model>-<scenario>-<ts>',
//     script: 'dist/worker.js', interpreter: 'node', exec_mode: 'fork',
//     autorestart: false, max_restarts: 0, cwd: process.cwd(),
//     time: true, merge_logs: true,
//     out_file: 'outputs/<model>/pm2-logs/<runId>.log',
//     env: { AI_ARENA_MODEL, AI_ARENA_SCENARIO, AI_ARENA_RUN_ID, AI_ARENA_ROOT },
//   }
export default {
  apps: [
    {
      name: 'ai-arena-dashboard',
      script: 'dist/dashboard-server/server.js',
      interpreter: 'node',
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 5,
      cwd: process.cwd(),
      time: true,
      env: {
        NODE_ENV: 'production',
        DASHBOARD_PORT: process.env.DASHBOARD_PORT ?? '4000',
        DASHBOARD_USERNAME: process.env.DASHBOARD_USERNAME ?? 'admin',
        // Set DASHBOARD_PASSWORD (and optionally DASHBOARD_JWT_SECRET) in your .env.
      },
    },
  ],
};

