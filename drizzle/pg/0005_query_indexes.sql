-- Missing indexes for the dashboard's hot query paths (see SQLite 0013).
CREATE INDEX IF NOT EXISTS "idx_messages_session" ON "messages" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_sessions_created" ON "sessions" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_sessions_status_model" ON "sessions" USING btree ("status","model");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_runs_status" ON "runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_runs_started" ON "runs" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_run_models_status" ON "run_models" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_cost_ledger_model_time" ON "cost_ledger" USING btree ("model","recorded_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_files_run" ON "files" USING btree ("run_id");
