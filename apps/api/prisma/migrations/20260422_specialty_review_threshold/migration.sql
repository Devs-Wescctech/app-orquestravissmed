-- Reclassify existing specialty mappings to new 90% threshold:
-- anything below 0.90 should require manual approval.
UPDATE "SpecialtyServiceMapping"
SET "requiresReview" = true
WHERE "confidenceScore" < 0.90
  AND "requiresReview" = false
  AND "isActive" = true;
