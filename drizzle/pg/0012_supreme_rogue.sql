-- Reconcile schema/index drift (see SQLite 0019): the audit, session/run/cost/file
-- query indexes and run_models/user_roles unique constraints were hand-written in
-- pg 0004/0005 and skipped on databases that had already applied a newer migration
-- (their journal `when` predates the generated 0006_wet_morgan_stark). Recreate
-- them idempotently alongside the new files/runs hot-query indexes.
CREATE INDEX IF NOT EXISTS "idx_audit_actor_at" ON "audit_log" USING btree ("actor","at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_audit_entity" ON "audit_log" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_audit_at" ON "audit_log" USING btree ("at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_audit_action" ON "audit_log" USING btree ("action");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_cost_ledger_model_time" ON "cost_ledger" USING btree ("model","recorded_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_files_run" ON "files" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_files_model_produced" ON "files" USING btree ("model","produced_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_files_tool_produced" ON "files" USING btree ("produced_by_tool","produced_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_files_prompt_produced" ON "files" USING btree ("prompt_id","produced_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_messages_session" ON "messages" USING btree ("session_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_run_models_run_model" ON "run_models" USING btree ("run_id","model");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_run_models_status" ON "run_models" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_runs_status" ON "runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_runs_started" ON "runs" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_runs_created_by" ON "runs" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_sessions_created" ON "sessions" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_sessions_status_model" ON "sessions" USING btree ("status","model");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_user_roles_user_role" ON "user_roles" USING btree ("user_id","role_id");
