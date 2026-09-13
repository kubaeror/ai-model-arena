ALTER TABLE "cost_ledger" ADD COLUMN "finalization_attempt" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "finalization_attempt" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Legacy crash-retry rows get distinct negative attempts (id order) instead of being deleted:
-- new claims start at 1, so positive attempts can never collide with a preserved legacy row.
UPDATE "cost_ledger" SET "finalization_attempt" = -(SELECT COUNT(*) FROM "cost_ledger" b WHERE b."run_id" = "cost_ledger"."run_id" AND b."model" = "cost_ledger"."model" AND b."id" <= "cost_ledger"."id");--> statement-breakpoint
CREATE INDEX "idx_cost_ledger_run" ON "cost_ledger" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_cost_ledger_run_model_attempt" ON "cost_ledger" USING btree ("run_id","model","finalization_attempt");