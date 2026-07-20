CREATE TABLE `_migrations` (
	`id` text PRIMARY KEY NOT NULL,
	`applied_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `benchmarks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`model_id` text NOT NULL,
	`benchmark` text NOT NULL,
	`source` text NOT NULL,
	`score` real NOT NULL,
	`measured_at` text NOT NULL,
	`source_url` text,
	`is_preferred` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`model_id`) REFERENCES `models`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_benchmarks_model_source` ON `benchmarks` (`model_id`,`benchmark`,`source`);--> statement-breakpoint
CREATE INDEX `idx_benchmarks_model` ON `benchmarks` (`model_id`,`benchmark`);--> statement-breakpoint
CREATE TABLE `catalog_cache_state` (
	`source` text PRIMARY KEY NOT NULL,
	`last_fetch` text NOT NULL,
	`last_status` text,
	`last_error` text,
	`count` integer,
	`next_refresh` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `model_providers` (
	`model_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`api_model_id` text NOT NULL,
	PRIMARY KEY(`model_id`, `provider_id`),
	FOREIGN KEY (`model_id`) REFERENCES `models`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `model_runtime_stats` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`model_id` text NOT NULL,
	`run_id` text NOT NULL,
	`latency_p50_ms` integer,
	`latency_p95_ms` integer,
	`tps` real,
	`ttft_ms` integer,
	`cache_hit_rate` real,
	`cache_read_tokens` integer,
	`cache_write_tokens` integer,
	`cost_usd` real,
	`success` integer NOT NULL,
	`measured_at` text NOT NULL,
	FOREIGN KEY (`model_id`) REFERENCES `models`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_runtime_model_run` ON `model_runtime_stats` (`model_id`,`run_id`);--> statement-breakpoint
CREATE INDEX `idx_runtime_model_date` ON `model_runtime_stats` (`model_id`,`measured_at`);--> statement-breakpoint
CREATE TABLE `models` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`family` text,
	`provider_id` text NOT NULL,
	`release_date` text,
	`attachment` integer DEFAULT 0 NOT NULL,
	`reasoning` integer DEFAULT 0 NOT NULL,
	`temperature` integer DEFAULT 0 NOT NULL,
	`tool_call` integer DEFAULT 0 NOT NULL,
	`interleaved` text,
	`status` text,
	`context_limit` integer,
	`input_limit` integer,
	`output_limit` integer,
	`modalities` text,
	`reasoning_options` text,
	`source_json` text,
	`last_synced_at` text NOT NULL,
	FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_models_provider_name` ON `models` (`provider_id`,`name`);--> statement-breakpoint
CREATE INDEX `idx_models_provider` ON `models` (`provider_id`);--> statement-breakpoint
CREATE INDEX `idx_models_reasoning` ON `models` (`reasoning`);--> statement-breakpoint
CREATE TABLE `pricing` (
	`model_id` text NOT NULL,
	`input` real,
	`output` real,
	`cache_read` real,
	`cache_write` real,
	`tier_size` integer,
	`over_200k_input` real,
	`over_200k_output` real,
	`over_200k_cache_read` real,
	`over_200k_cache_write` real,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`model_id`, `tier_size`),
	FOREIGN KEY (`model_id`) REFERENCES `models`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `providers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`api_base` text,
	`auth_scheme` text NOT NULL,
	`env_var` text,
	`is_builtin` integer DEFAULT 0 NOT NULL,
	`adapter` text NOT NULL,
	`header_name` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
