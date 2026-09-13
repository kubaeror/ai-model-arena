-- Reconcile schema/index drift: the audit, session/run/cost/file query indexes
-- and run_models/user_roles unique constraints were hand-written in 0012/0013
-- and skipped on databases that had already applied a newer migration (their
-- journal `when` predates the generated 0013_marvelous_juggernaut). Recreate
-- them idempotently alongside the new files/runs hot-query indexes.
CREATE INDEX IF NOT EXISTS `idx_audit_actor_at` ON `audit_log` (`actor`,`at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_audit_entity` ON `audit_log` (`entity_type`,`entity_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_audit_at` ON `audit_log` (`at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_audit_action` ON `audit_log` (`action`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_cost_ledger_model_time` ON `cost_ledger` (`model`,`recorded_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_files_run` ON `files` (`run_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_files_model_produced` ON `files` (`model`,`produced_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_files_tool_produced` ON `files` (`produced_by_tool`,`produced_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_files_prompt_produced` ON `files` (`prompt_id`,`produced_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_messages_session` ON `messages` (`session_id`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_run_models_run_model` ON `run_models` (`run_id`,`model`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_run_models_status` ON `run_models` (`status`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_runs_status` ON `runs` (`status`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_runs_started` ON `runs` (`started_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_runs_created_by` ON `runs` (`created_by`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_sessions_created` ON `sessions` (`created_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_sessions_status_model` ON `sessions` (`status`,`model`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_user_roles_user_role` ON `user_roles` (`user_id`,`role_id`);
