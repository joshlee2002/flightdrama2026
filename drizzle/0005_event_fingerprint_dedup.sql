-- Migration: Event-fingerprint deduplication
-- Adds three new columns to `stories` for structural dedup:
--   eventFingerprint — same-event identity key (airline|flightno|aircraft|location|incident|date)
--   contentHash      — SHA-256 of normalised title+content (catches verbatim reposts)
--   canonicalUrl     — resolved URL after redirect stripping
--
-- Also fixes the seen_urls table: adds a UNIQUE constraint on `url` so that
-- markUrlAsSeen's onDuplicateKeyUpdate actually works as intended.
--> statement-breakpoint
ALTER TABLE `stories`
  ADD COLUMN `eventFingerprint` varchar(512) NULL,
  ADD COLUMN `contentHash` varchar(64) NULL,
  ADD COLUMN `canonicalUrl` varchar(768) NULL;
--> statement-breakpoint
-- Index for fast fingerprint lookups during ingestion
CREATE INDEX `stories_eventFingerprint_idx` ON `stories` (`eventFingerprint`);
--> statement-breakpoint
-- Index for fast content-hash lookups
CREATE INDEX `stories_contentHash_idx` ON `stories` (`contentHash`);
--> statement-breakpoint
-- Fix seen_urls: shrink url column to 768 chars (matches stories.sourceUrl),
-- deduplicate existing rows (keep newest per url), then add unique constraint.
ALTER TABLE `seen_urls`
  MODIFY COLUMN `url` varchar(768) NOT NULL;
--> statement-breakpoint
DELETE s1 FROM `seen_urls` s1
INNER JOIN `seen_urls` s2
  ON s1.url = s2.url AND s1.id < s2.id;
--> statement-breakpoint
ALTER TABLE `seen_urls`
  ADD CONSTRAINT `seen_urls_url_unique` UNIQUE (`url`);
