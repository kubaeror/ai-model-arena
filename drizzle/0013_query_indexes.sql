-- Missing indexes for the dashboard's hot query paths: session list/messages,
-- run status polling (live.ts scans every 3s), cost summary, and file listing.
CREATE INDEX IF NOT EXISTS `idx_messages_session` ON `messages` (`session_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_sessions_created` ON `sessions` (`created_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_sessions_status_model` ON `sessions` (`status`,`model`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_runs_status` ON `runs` (`status`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_runs_started` ON `runs` (`started_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_run_models_status` ON `run_models` (`status`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_cost_ledger_model_time` ON `cost_ledger` (`model`,`recorded_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_files_run` ON `files` (`run_id`);
