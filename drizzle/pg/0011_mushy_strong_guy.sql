CREATE TABLE "notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"event_type" text NOT NULL,
	"channel" text NOT NULL,
	"payload_json" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" text NOT NULL,
	"next_attempt_at" text,
	"delivered_at" text
);
--> statement-breakpoint
CREATE INDEX "idx_notifications_due" ON "notifications" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "idx_notifications_created" ON "notifications" USING btree ("created_at");