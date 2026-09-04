-- Execute manually only after confirming no Task 261 reader is deployed.
BEGIN;
DROP TABLE IF EXISTS "DoctoraliaCatalogAttemptBucket";
DROP TABLE IF EXISTS "DoctoraliaCatalogLease";
DROP TABLE IF EXISTS "DoctoraliaCatalogCredential";
DROP TABLE IF EXISTS "DoctoraliaCatalogMember";
DROP TABLE IF EXISTS "DoctoraliaCatalogGeneration";
DROP INDEX IF EXISTS "IntegrationConnection_id_clinicId_key";
ALTER TABLE "IntegrationConnection" DROP COLUMN IF EXISTS "catalogScopeVersion";
COMMIT;