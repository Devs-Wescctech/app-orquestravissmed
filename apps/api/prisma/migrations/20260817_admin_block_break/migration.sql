-- CreateEnum
CREATE TYPE "AdminBlockBreakStatus" AS ENUM ('ACTIVE', 'CANCELLED');

-- CreateTable
CREATE TABLE "AdminBlockBreak" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "idprofissional" INTEGER NOT NULL,
    "dataagendamento" TEXT NOT NULL,
    "horarioagendamento" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "periodHash" TEXT NOT NULL,
    "rawEndTime" TEXT,
    "doctoraliaBreakId" TEXT,
    "addressId" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "status" "AdminBlockBreakStatus" NOT NULL DEFAULT 'ACTIVE',
    "lastSyncAttemptAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdminBlockBreak_pkey" PRIMARY KEY ("id")
);

-- CreateIndex (chave natural única)
CREATE UNIQUE INDEX "AdminBlockBreak_clinicId_idprofissional_dataagendamento_horarioagendamento_addressId_key"
    ON "AdminBlockBreak"("clinicId", "idprofissional", "dataagendamento", "horarioagendamento", "addressId");

-- CreateIndex (diff por clínica)
CREATE INDEX "AdminBlockBreak_clinicId_status_idx"
    ON "AdminBlockBreak"("clinicId", "status");

-- CreateIndex (diff por médico)
CREATE INDEX "AdminBlockBreak_clinicId_idprofissional_status_idx"
    ON "AdminBlockBreak"("clinicId", "idprofissional", "status");

-- CreateIndex (lookup por break Doctoralia)
CREATE INDEX "AdminBlockBreak_doctoraliaBreakId_idx"
    ON "AdminBlockBreak"("doctoraliaBreakId");
