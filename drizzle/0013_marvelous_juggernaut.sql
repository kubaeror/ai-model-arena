PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_pricing` (
	`model_id` text NOT NULL,
	`input` real,
	`output` real,
	`cache_read` real,
	`cache_write` real,
	`tier_size` integer DEFAULT 0 NOT NULL,
	`over_200k_input` real,
	`over_200k_output` real,
	`over_200k_cache_read` real,
	`over_200k_cache_write` real,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`model_id`, `tier_size`),
	FOREIGN KEY (`model_id`) REFERENCES `models`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_pricing`("model_id", "input", "output", "cache_read", "cache_write", "tier_size", "over_200k_input", "over_200k_output", "over_200k_cache_read", "over_200k_cache_write", "updated_at") SELECT "model_id", "input", "output", "cache_read", "cache_write", "tier_size", "over_200k_input", "over_200k_output", "over_200k_cache_read", "over_200k_cache_write", "updated_at" FROM `pricing`;--> statement-breakpoint
DROP TABLE `pricing`;--> statement-breakpoint
ALTER TABLE `__new_pricing` RENAME TO `pricing`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
ALTER TABLE `run_models` DROP COLUMN `proc_name`;