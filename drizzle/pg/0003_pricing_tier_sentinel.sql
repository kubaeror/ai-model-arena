-- tier_size becomes a NOT NULL sentinel (0 = "no tier") so the (model_id,
-- tier_size) PK works on Postgres, where PK columns are implicitly NOT NULL.
--> statement-breakpoint
-- Dedupe pre-existing NULL-tier rows first (NULLs are distinct in PG PKs).
DELETE FROM "pricing" a USING "pricing" b
WHERE a."model_id" = b."model_id" AND a."tier_size" IS NULL AND b."tier_size" IS NULL AND a.ctid < b.ctid;
--> statement-breakpoint
ALTER TABLE "pricing" ALTER COLUMN "tier_size" SET DEFAULT 0;
--> statement-breakpoint
UPDATE "pricing" SET "tier_size" = 0 WHERE "tier_size" IS NULL;
--> statement-breakpoint
ALTER TABLE "pricing" ALTER COLUMN "tier_size" SET NOT NULL;
