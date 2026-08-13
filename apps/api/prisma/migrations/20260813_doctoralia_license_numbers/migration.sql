-- Task 141: persistir license numbers (CRM etc.) dos médicos Doctoralia
ALTER TABLE "DoctoraliaDoctor" ADD COLUMN IF NOT EXISTS "licenseNumbers" TEXT[] NOT NULL DEFAULT '{}';
