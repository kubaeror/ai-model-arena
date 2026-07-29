CREATE TABLE `pricing_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`version` text NOT NULL,
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
	`snapshot_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `provider_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`provider_id` text NOT NULL,
	`version` integer NOT NULL,
	`name` text NOT NULL,
	`api_base` text,
	`auth_scheme` text NOT NULL,
	`env_var` text,
	`adapter` text NOT NULL,
	`header_name` text,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_provider_versions_provider` ON `provider_versions` (`provider_id`);--> statement-breakpoint
CREATE TABLE `tool_call_stats` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` text NOT NULL,
	`model` text NOT NULL,
	`tool_name` text NOT NULL,
	`total` integer DEFAULT 0 NOT NULL,
	`success_count` integer DEFAULT 0 NOT NULL,
	`fail_count` integer DEFAULT 0 NOT NULL,
	`recorded_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`run_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_tool_stats_run` ON `tool_call_stats` (`run_id`);--> statement-breakpoint
CREATE INDEX `idx_tool_stats_model_tool` ON `tool_call_stats` (`model`,`tool_name`);--> statement-breakpoint
CREATE INDEX `idx_tool_stats_recorded` ON `tool_call_stats` (`recorded_at`);