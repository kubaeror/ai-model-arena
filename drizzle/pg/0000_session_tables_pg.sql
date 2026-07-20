CREATE TABLE "_migrations" (
	"id" text PRIMARY KEY NOT NULL,
	"applied_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "anomalies" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"model" text NOT NULL,
	"type" text NOT NULL,
	"severity" text NOT NULL,
	"description" text NOT NULL,
	"detected_at" text NOT NULL,
	"resolved" integer DEFAULT 0 NOT NULL,
	"resolved_at" text,
	"resolved_as" text,
	"metadata_json" text
);
--> statement-breakpoint
CREATE TABLE "benchmarks" (
	"id" serial PRIMARY KEY NOT NULL,
	"model_id" text NOT NULL,
	"benchmark" text NOT NULL,
	"source" text NOT NULL,
	"score" real NOT NULL,
	"measured_at" text NOT NULL,
	"source_url" text,
	"is_preferred" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "catalog_cache_state" (
	"source" text PRIMARY KEY NOT NULL,
	"last_fetch" text NOT NULL,
	"last_status" text,
	"last_error" text,
	"count" integer,
	"next_refresh" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"turn" integer NOT NULL,
	"role" text NOT NULL,
	"content" text,
	"tool_calls" text,
	"tool_call_id" text,
	"token_input" integer,
	"token_output" integer,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_calls" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"turn" integer NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"request_hash" text NOT NULL,
	"response_text" text,
	"usage" text,
	"latency_ms" integer,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_providers" (
	"model_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"api_model_id" text NOT NULL,
	CONSTRAINT "model_providers_model_id_provider_id_pk" PRIMARY KEY("model_id","provider_id")
);
--> statement-breakpoint
CREATE TABLE "model_runtime_stats" (
	"id" serial PRIMARY KEY NOT NULL,
	"model_id" text NOT NULL,
	"run_id" text NOT NULL,
	"latency_p50_ms" integer,
	"latency_p95_ms" integer,
	"tps" real,
	"ttft_ms" integer,
	"cache_hit_rate" real,
	"cache_read_tokens" integer,
	"cache_write_tokens" integer,
	"cost_usd" real,
	"success" integer NOT NULL,
	"measured_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "models" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"family" text,
	"provider_id" text NOT NULL,
	"release_date" text,
	"attachment" integer DEFAULT 0 NOT NULL,
	"reasoning" integer DEFAULT 0 NOT NULL,
	"temperature" integer DEFAULT 0 NOT NULL,
	"tool_call" integer DEFAULT 0 NOT NULL,
	"interleaved" text,
	"status" text,
	"context_limit" integer,
	"input_limit" integer,
	"output_limit" integer,
	"modalities" text,
	"reasoning_options" text,
	"source_json" text,
	"last_synced_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pricing" (
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
	"updated_at" text NOT NULL,
	CONSTRAINT "pricing_model_id_tier_size_pk" PRIMARY KEY("model_id","tier_size")
);
--> statement-breakpoint
CREATE TABLE "providers" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"api_base" text,
	"auth_scheme" text NOT NULL,
	"env_var" text,
	"is_builtin" integer DEFAULT 0 NOT NULL,
	"adapter" text NOT NULL,
	"header_name" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_models" (
	"run_id" text NOT NULL,
	"model" text NOT NULL,
	"proc_name" text,
	"output_dir" text,
	"sandbox_dir" text,
	"result_path" text,
	"conversation_path" text,
	"report_path" text,
	"log_file" text,
	"status" text NOT NULL,
	"success" integer,
	"turns_used" integer,
	"total_tool_calls" integer,
	"stop_reason" text,
	"duration_ms" integer
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"run_id" text PRIMARY KEY NOT NULL,
	"scenario" text NOT NULL,
	"models" text NOT NULL,
	"started_at" text NOT NULL,
	"finished_at" text,
	"status" text NOT NULL,
	"source" text NOT NULL,
	"comparison_md_path" text,
	"comparison_json_path" text
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"prompt_id" text,
	"prompt_version" integer,
	"model" text,
	"status" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhooks" (
	"id" serial PRIMARY KEY NOT NULL,
	"url" text NOT NULL,
	"events" text NOT NULL,
	"secret" text,
	"created_at" text NOT NULL,
	"active" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "benchmarks" ADD CONSTRAINT "benchmarks_model_id_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."models"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_calls" ADD CONSTRAINT "model_calls_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_providers" ADD CONSTRAINT "model_providers_model_id_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."models"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_providers" ADD CONSTRAINT "model_providers_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_runtime_stats" ADD CONSTRAINT "model_runtime_stats_model_id_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."models"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "models" ADD CONSTRAINT "models_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pricing" ADD CONSTRAINT "pricing_model_id_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."models"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_models" ADD CONSTRAINT "run_models_run_id_runs_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_anomalies_run" ON "anomalies" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "idx_anomalies_model" ON "anomalies" USING btree ("model");--> statement-breakpoint
CREATE INDEX "idx_anomalies_type" ON "anomalies" USING btree ("type");--> statement-breakpoint
CREATE INDEX "idx_anomalies_resolved" ON "anomalies" USING btree ("resolved");--> statement-breakpoint
CREATE INDEX "idx_anomalies_detected" ON "anomalies" USING btree ("detected_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_benchmarks_model_source" ON "benchmarks" USING btree ("model_id","benchmark","source");--> statement-breakpoint
CREATE INDEX "idx_benchmarks_model" ON "benchmarks" USING btree ("model_id","benchmark");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_runtime_model_run" ON "model_runtime_stats" USING btree ("model_id","run_id");--> statement-breakpoint
CREATE INDEX "idx_runtime_model_date" ON "model_runtime_stats" USING btree ("model_id","measured_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_models_provider_name" ON "models" USING btree ("provider_id","name");--> statement-breakpoint
CREATE INDEX "idx_models_provider" ON "models" USING btree ("provider_id");--> statement-breakpoint
CREATE INDEX "idx_models_reasoning" ON "models" USING btree ("reasoning");