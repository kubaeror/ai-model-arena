CREATE TABLE `anomalies` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` text NOT NULL,
	`model` text NOT NULL,
	`type` text NOT NULL,
	`severity` text NOT NULL,
	`description` text NOT NULL,
	`detected_at` text NOT NULL,
	`resolved` integer DEFAULT 0 NOT NULL,
	`resolved_at` text,
	`resolved_as` text,
	`metadata_json` text
);
--> statement-breakpoint
CREATE INDEX `idx_anomalies_run` ON `anomalies` (`run_id`);--> statement-breakpoint
CREATE INDEX `idx_anomalies_model` ON `anomalies` (`model`);--> statement-breakpoint
CREATE INDEX `idx_anomalies_type` ON `anomalies` (`type`);--> statement-breakpoint
CREATE INDEX `idx_anomalies_resolved` ON `anomalies` (`resolved`);--> statement-breakpoint
CREATE INDEX `idx_anomalies_detected` ON `anomalies` (`detected_at`);--> statement-breakpoint
CREATE TABLE `webhooks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`url` text NOT NULL,
	`events` text NOT NULL,
	`secret` text,
	`created_at` text NOT NULL,
	`active` integer DEFAULT 1 NOT NULL
);
