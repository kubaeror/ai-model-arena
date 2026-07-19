// CommonJS ecosystem config — reliably loadable by PM2 5.x (the project is
// `"type": "module"`, so the ESM ecosystem.config.js may not load on older PM2).
// Start the dashboard with:  pm2 start ecosystem.config.cjs
//
// Worker processes (one per model per run) are started DYNAMICALLY by the
// orchestrator via the PM2 *programmatic* API with unique names
// `ai-arena-<model>-<scenario>-<ts>`, so they are not declared here.
module.exports = {
  apps: [
    {
      name: 'ai-arena-dashboard',
      script: 'dist/dashboard-server/server.js',
      interpreter: 'node',
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 5,
      cwd: __dirname,
      time: true,
      env: {
        NODE_ENV: 'production',
        DASHBOARD_PORT: process.env.DASHBOARD_PORT || '4000',
        DASHBOARD_USERNAME: process.env.DASHBOARD_USERNAME || 'admin',
        // Set DASHBOARD_PASSWORD (and optionally DASHBOARD_JWT_SECRET) in your .env.
      },
    },
  ],
};
