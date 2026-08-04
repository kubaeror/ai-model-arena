ALTER TABLE "pricing" ALTER COLUMN "tier_size" SET DEFAULT 0;--> statement-breakpoint
ALTER TABLE "pricing" ALTER COLUMN "tier_size" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "run_models" DROP COLUMN "proc_name";