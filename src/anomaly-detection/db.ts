// Consolidation shim (Task 7): anomaly/webhook table queries now live in
// src/db/query/anomalies.ts and src/db/query/webhooks.ts. This module
// re-exports them so existing importers of anomaly-detection/db.js
// (anomaly-detection/index.ts, detectors.ts, observability/stats.ts,
// notifications/webhooks.ts, tests) keep working unchanged.
export { insertAnomaly, listAnomalies, getAnomaly, listAnomaliesForRun, resolveAnomaly, anomalyCountsByModel } from '../db/query/anomalies.js';
export type { AnomalyType, AnomalySeverity, AnomalyRecord, NewAnomaly, AnomalyQuery } from '../db/query/anomalies.js';
export { insertWebhook, getWebhookSecret, listWebhooks, deleteWebhook, webhooksForEvent } from '../db/query/webhooks.js';
export type { WebhookRecord, NewWebhook } from '../db/query/webhooks.js';
