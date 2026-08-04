-- Runtime-only DDL promoted into migrations: audit indexes and the unique
-- constraints that upserts rely on (previously applied in code after every
-- migration run, and never applied to Postgres at all).
CREATE INDEX IF NOT EXISTS `idx_audit_actor_at` ON `audit_log` (`actor`,`at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_audit_entity` ON `audit_log` (`entity_type`,`entity_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_audit_at` ON `audit_log` (`at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_audit_action` ON `audit_log` (`action`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_run_models_run_model` ON `run_models` (`run_id`,`model`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_user_roles_user_role` ON `user_roles` (`user_id`,`role_id`);
