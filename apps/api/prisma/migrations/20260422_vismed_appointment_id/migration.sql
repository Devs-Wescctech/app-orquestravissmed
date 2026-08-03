-- Add VisMed appointment id column for booking sync reconciliation
ALTER TABLE "BookingSync" ADD COLUMN IF NOT EXISTS "vismedAppointmentId" TEXT;

-- Drop the global unique index from a prior db push (if it exists)
DROP INDEX IF EXISTS "BookingSync_vismedAppointmentId_key";

-- Composite uniqueness scoped per clinic (multi-tenant safe)
CREATE UNIQUE INDEX IF NOT EXISTS "BookingSync_clinicId_vismedAppointmentId_key"
  ON "BookingSync"("clinicId", "vismedAppointmentId");

-- Helper index for reconciliation lookups
CREATE INDEX IF NOT EXISTS "BookingSync_clinicId_vismedDoctorId_startAt_idx"
  ON "BookingSync"("clinicId", "vismedDoctorId", "startAt");
