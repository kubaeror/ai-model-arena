CREATE TABLE `run_models` (
	`run_id` text NOT NULL,
	`model` text NOT NULL,
	`proc_name` text,
	`output_dir` text,
	`sandbox_dir` text,
	`result_path` text,
	`conversation_path` text,
	`report_path` text,
	`log_file` text,
	`status` text NOT NULL,
	`success` integer,
	`turns_used` integer,
	`total_tool_calls` integer,
	`stop_reason` text,
	`duration_ms` integer,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`run_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `runs` (
	`run_id` text PRIMARY KEY NOT NULL,
	`scenario` text NOT NULL,
	`models` text NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`status` text NOT NULL,
	`source` text NOT NULL,
	`comparison_md_path` text,
	`comparison_json_path` text
);
