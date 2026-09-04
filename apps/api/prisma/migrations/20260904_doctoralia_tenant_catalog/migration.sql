-- Task 261: dedicated tenant-safe Doctoralia catalog snapshots.
-- Registration strings are parsed in memory and only normalized credentials persist.
ALTER TABLE "IntegrationConnection"
  ADD COLUMN "catalogScopeVersion" INTEGER NOT NULL DEFAULT 1;

-- Required by the composite tenant-bound foreign keys below.
CREATE UNIQUE INDEX "IntegrationConnection_id_clinicId_key"
  ON "IntegrationConnection"("id", "clinicId");

CREATE TABLE "DoctoraliaCatalogGeneration" (
  "id" TEXT NOT NULL,
  "clinicId" TEXT NOT NULL,
  "connectionId" TEXT NOT NULL,
  "catalogScopeVersion" INTEGER NOT NULL,
  "facilityCount" INTEGER NOT NULL,
  "doctorCount" INTEGER NOT NULL,
  "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DoctoraliaCatalogGeneration_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DoctoraliaCatalogMember" (
  "id" TEXT NOT NULL,
  "generationId" TEXT NOT NULL,
  "facilityId" TEXT NOT NULL,
  "doctoraliaDoctorId" TEXT NOT NULL,
  "doctoraliaExternalId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DoctoraliaCatalogMember_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "DoctoraliaCatalogCredential" (
  "id" TEXT NOT NULL,
  "memberId" TEXT NOT NULL,
  "council" TEXT NOT NULL,
  "number" TEXT NOT NULL,
  "uf" TEXT,
  "regional" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DoctoraliaCatalogCredential_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "DoctoraliaCatalogLease" (
  "connectionId" TEXT NOT NULL,
  "clinicId" TEXT NOT NULL,
  "owner" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DoctoraliaCatalogLease_pkey" PRIMARY KEY ("connectionId")
);
CREATE TABLE "DoctoraliaCatalogAttemptBucket" (
  "bucketStart" TIMESTAMP(3) NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DoctoraliaCatalogAttemptBucket_pkey" PRIMARY KEY ("bucketStart")
);

CREATE INDEX "DoctoraliaCatalogGeneration_clinicId_connectionId_catalogSc_idx"
  ON "DoctoraliaCatalogGeneration"("clinicId", "connectionId", "catalogScopeVersion", "publishedAt");
CREATE INDEX "DoctoraliaCatalogGeneration_expiresAt_idx" ON "DoctoraliaCatalogGeneration"("expiresAt");
CREATE UNIQUE INDEX "DoctoraliaCatalogMember_generationId_facilityId_doctoraliaE_key"
  ON "DoctoraliaCatalogMember"("generationId", "facilityId", "doctoraliaExternalId");
CREATE INDEX "DoctoraliaCatalogMember_generationId_doctoraliaDoctorId_idx"
  ON "DoctoraliaCatalogMember"("generationId", "doctoraliaDoctorId");
CREATE UNIQUE INDEX "DoctoraliaCatalogCredential_memberId_council_number_uf_regi_key"
  ON "DoctoraliaCatalogCredential"("memberId", "council", "number", "uf", "regional");
CREATE INDEX "DoctoraliaCatalogCredential_council_number_uf_regional_idx"
  ON "DoctoraliaCatalogCredential"("council", "number", "uf", "regional");
CREATE INDEX "DoctoraliaCatalogCredential_memberId_idx" ON "DoctoraliaCatalogCredential"("memberId");
CREATE INDEX "DoctoraliaCatalogLease_clinicId_expiresAt_idx"
  ON "DoctoraliaCatalogLease"("clinicId", "expiresAt");
CREATE UNIQUE INDEX "DoctoraliaCatalogLease_connectionId_clinicId_key"
  ON "DoctoraliaCatalogLease"("connectionId", "clinicId");

ALTER TABLE "DoctoraliaCatalogGeneration"
  ADD CONSTRAINT "DoctoraliaCatalogGeneration_clinicId_fkey"
  FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DoctoraliaCatalogGeneration"
  ADD CONSTRAINT "DoctoraliaCatalogGeneration_connectionId_clinicId_fkey"
  FOREIGN KEY ("connectionId", "clinicId") REFERENCES "IntegrationConnection"("id", "clinicId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DoctoraliaCatalogMember"
  ADD CONSTRAINT "DoctoraliaCatalogMember_generationId_fkey"
  FOREIGN KEY ("generationId") REFERENCES "DoctoraliaCatalogGeneration"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DoctoraliaCatalogMember"
  ADD CONSTRAINT "DoctoraliaCatalogMember_doctoraliaDoctorId_fkey"
  FOREIGN KEY ("doctoraliaDoctorId") REFERENCES "DoctoraliaDoctor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DoctoraliaCatalogCredential"
  ADD CONSTRAINT "DoctoraliaCatalogCredential_memberId_fkey"
  FOREIGN KEY ("memberId") REFERENCES "DoctoraliaCatalogMember"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DoctoraliaCatalogLease"
  ADD CONSTRAINT "DoctoraliaCatalogLease_clinicId_fkey"
  FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DoctoraliaCatalogLease"
  ADD CONSTRAINT "DoctoraliaCatalogLease_connectionId_clinicId_fkey"
  FOREIGN KEY ("connectionId", "clinicId") REFERENCES "IntegrationConnection"("id", "clinicId") ON DELETE CASCADE ON UPDATE CASCADE;