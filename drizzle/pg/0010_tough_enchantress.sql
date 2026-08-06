ALTER TABLE "schedules" ADD COLUMN "last_status" text;--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN "consecutive_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN "total_runs" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN "total_failures" integer DEFAULT 0 NOT NULL;