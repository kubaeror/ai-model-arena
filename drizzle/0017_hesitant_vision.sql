ALTER TABLE `schedules` ADD `last_status` text;--> statement-breakpoint
ALTER TABLE `schedules` ADD `last_error` text;--> statement-breakpoint
ALTER TABLE `schedules` ADD `consecutive_failures` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `schedules` ADD `total_runs` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `schedules` ADD `total_failures` integer DEFAULT 0 NOT NULL;