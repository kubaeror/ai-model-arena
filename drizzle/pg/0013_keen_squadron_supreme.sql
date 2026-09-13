ALTER TABLE "cost_ledger" ADD COLUMN "finalization_attempt" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "finalization_attempt" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
DELETE FROM "cost_ledger" WHERE "id" NOT IN (SELECT MIN("id") FROM "cost_ledger" GROUP BY "run_id", "model", "finalization_attempt");--> statement-breakpoint
CREATE INDEX "idx_cost_ledger_run" ON "cost_ledger" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_cost_ledger_run_model_attempt" ON "cost_ledger" USING btree ("run_id","model","finalization_attempt");