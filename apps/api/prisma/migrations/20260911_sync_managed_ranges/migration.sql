-- Additive, no backfill: legacy hashes cannot prove the exact managed intervals.
ALTER TABLE "SlotPushState" ADD COLUMN "managedState" JSONB;
-- Rollback application remains compatible. Keep this column when reverting the image.
