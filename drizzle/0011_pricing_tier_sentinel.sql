CREATE TABLE `pricing_new` (
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
-- Dedupe pre-existing NULL-tier rows (SQLite treats NULLs as distinct in
-- PKs, so repeated syncs could create duplicates). Keep the newest row.
INSERT INTO `pricing_new` (`model_id`, `input`, `output`, `cache_read`, `cache_write`, `tier_size`, `over_200k_input`, `over_200k_output`, `over_200k_cache_read`, `over_200k_cache_write`, `updated_at`)
SELECT `model_id`, `input`, `output`, `cache_read`, `cache_write`, 0, `over_200k_input`, `over_200k_output`, `over_200k_cache_read`, `over_200k_cache_write`, `updated_at`
FROM `pricing`
WHERE `rowid` IN (SELECT MAX(`rowid`) FROM `pricing` GROUP BY `model_id`);
--> statement-breakpoint
DROP TABLE `pricing`;
--> statement-breakpoint
ALTER TABLE `pricing_new` RENAME TO `pricing`;
