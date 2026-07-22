-- Migration: Add pricing_snapshots table for versioned pricing audit trail.
CREATE TABLE IF NOT EXISTS `pricing_snapshots` (
    `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
    `version` text NOT NULL,
    `model_id` text NOT NULL,
    `input` real,
    `output` real,
    `cache_read` real,
    `cache_write` real,
    `tier_size` integer,
    `over_200k_input` real,
    `over_200k_output` real,
    `over_200k_cache_read` real,
    `over_200k_cache_write` real,
    `snapshot_at` text NOT NULL
)
