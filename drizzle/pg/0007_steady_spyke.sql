CREATE TABLE "judge_scores" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"model" text NOT NULL,
	"judge_model" text NOT NULL,
	"average_score" real NOT NULL,
	"summary" text NOT NULL,
	"scores_json" text NOT NULL,
	"judged_at" text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_judge_scores_run_model" ON "judge_scores" USING btree ("run_id","model");