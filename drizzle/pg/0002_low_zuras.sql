CREATE TABLE "cost_ledger" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"model" text NOT NULL,
	"cost_usd" real NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"cache_read_tokens" integer,
	"total_tokens" integer,
	"pricing_version" text,
	"recorded_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pricing_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"version" text NOT NULL,
	"model_id" text NOT NULL,
	"input" real,
	"output" real,
	"cache_read" real,
	"cache_write" real,
	"tier_size" integer,
	"over_200k_input" real,
	"over_200k_output" real,
	"over_200k_cache_read" real,
	"over_200k_cache_write" real,
	"snapshot_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"provider_id" text NOT NULL,
	"version" integer NOT NULL,
	"name" text NOT NULL,
	"api_base" text,
	"auth_scheme" text NOT NULL,
	"env_var" text,
	"adapter" text NOT NULL,
	"header_name" text,
	"created_by" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tool_call_stats" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"model" text NOT NULL,
	"tool_name" text NOT NULL,
	"total" integer DEFAULT 0 NOT NULL,
	"success_count" integer DEFAULT 0 NOT NULL,
	"fail_count" integer DEFAULT 0 NOT NULL,
	"recorded_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "run_models" ADD COLUMN "claimed_at" text;--> statement-breakpoint
ALTER TABLE "run_models" ADD COLUMN "started_at" text;--> statement-breakpoint
ALTER TABLE "run_models" ADD COLUMN "completed_at" text;--> statement-breakpoint
ALTER TABLE "run_models" ADD COLUMN "runner_id" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "created_by" text;--> statement-breakpoint
ALTER TABLE "cost_ledger" ADD CONSTRAINT "cost_ledger_run_id_runs_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_versions" ADD CONSTRAINT "provider_versions_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_call_stats" ADD CONSTRAINT "tool_call_stats_run_id_runs_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_provider_versions_provider" ON "provider_versions" USING btree ("provider_id");--> statement-breakpoint
CREATE INDEX "idx_tool_stats_run" ON "tool_call_stats" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "idx_tool_stats_model_tool" ON "tool_call_stats" USING btree ("model","tool_name");--> statement-breakpoint
CREATE INDEX "idx_tool_stats_recorded" ON "tool_call_stats" USING btree ("recorded_at");