CREATE TABLE `cost_ledger` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` text NOT NULL,
	`model` text NOT NULL,
	`cost_usd` real NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`input_tokens` integer,
	`output_tokens` integer,
	`cache_read_tokens` integer,
	`total_tokens` integer,
	`pricing_version` text,
	`recorded_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`run_id`) ON UPDATE no action ON DELETE no action
);
