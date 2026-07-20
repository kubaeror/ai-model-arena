CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`turn` integer NOT NULL,
	`role` text NOT NULL,
	`content` text,
	`tool_calls` text,
	`tool_call_id` text,
	`token_input` integer,
	`token_output` integer,
	`created_at` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `model_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`turn` integer NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`request_hash` text NOT NULL,
	`response_text` text,
	`usage` text,
	`latency_ms` integer,
	`created_at` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`prompt_id` text,
	`prompt_version` integer,
	`model` text,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
