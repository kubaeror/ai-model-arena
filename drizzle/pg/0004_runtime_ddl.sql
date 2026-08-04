-- Runtime-only DDL promoted into migrations (was applied in code for SQLite
-- only; Postgres never got these, breaking run_models upserts).
CREATE INDEX IF NOT EXISTS "idx_audit_actor_at" ON "audit_log" USING btree ("actor","at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_audit_entity" ON "audit_log" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_audit_at" ON "audit_log" USING btree ("at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_audit_action" ON "audit_log" USING btree ("action");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_run_models_run_model" ON "run_models" USING btree ("run_id","model");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_user_roles_user_role" ON "user_roles" USING btree ("user_id","role_id");
