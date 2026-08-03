-- Add facilityId to IntegrationConnection
ALTER TABLE "IntegrationConnection" ADD COLUMN IF NOT EXISTS "facilityId" TEXT;
