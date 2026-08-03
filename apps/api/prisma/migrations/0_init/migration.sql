-- CreateEnum
CREATE TYPE "Role" AS ENUM ('SUPER_ADMIN', 'CLINIC_ADMIN', 'OPERATOR', 'READONLY');

-- CreateEnum
CREATE TYPE "MappingEntityType" AS ENUM ('DOCTOR', 'LOCATION', 'SERVICE', 'INSURANCE', 'FACILITY');

-- CreateEnum
CREATE TYPE "MappingStatus" AS ENUM ('LINKED', 'UNLINKED', 'CONFLICT', 'ORPHAN', 'PENDING_REVIEW');

-- CreateEnum
CREATE TYPE "AppointmentStatus" AS ENUM ('SCHEDULED', 'CONFIRMED', 'COMPLETED', 'CANCELLED', 'NO_SHOW');

-- CreateEnum
CREATE TYPE "MatchType" AS ENUM ('EXACT', 'APPROXIMATE', 'SYNONYM', 'MANUAL');

-- CreateEnum
CREATE TYPE "BookingOrigin" AS ENUM ('VISMED', 'DOCTORALIA');

-- CreateEnum
CREATE TYPE "BookingSyncStatus" AS ENUM ('BOOKED', 'CONFIRMED', 'CANCELLED', 'MOVED', 'NO_SHOW', 'FAILED', 'PROCESSING');

-- CreateEnum
CREATE TYPE "SyncJobStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'DEAD');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Clinic" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "cnpj" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'America/Sao_Paulo',
    "addressStreet" TEXT,
    "addressNumber" TEXT,
    "addressComplement" TEXT,
    "addressNeighborhood" TEXT,
    "addressCity" TEXT,
    "addressState" TEXT,
    "addressZipCode" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Clinic_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserClinicRole" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'READONLY',

    CONSTRAINT "UserClinicRole_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntegrationConnection" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'doctoralia',
    "domain" TEXT,
    "clientId" TEXT,
    "clientSecret" TEXT,
    "status" TEXT NOT NULL DEFAULT 'disconnected',
    "lastTestAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntegrationConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Mapping" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "entityType" "MappingEntityType" NOT NULL,
    "vismedId" TEXT,
    "externalId" TEXT,
    "status" "MappingStatus" NOT NULL DEFAULT 'UNLINKED',
    "conflictData" JSONB,
    "lastSyncAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Mapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VismedUnit" (
    "id" TEXT NOT NULL,
    "vismedId" INTEGER NOT NULL,
    "codUnidade" INTEGER,
    "name" TEXT NOT NULL,
    "cnpj" TEXT,
    "cityName" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VismedUnit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VismedDoctor" (
    "id" TEXT NOT NULL,
    "vismedId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "formalName" TEXT,
    "cpf" TEXT,
    "documentNumber" TEXT,
    "documentType" TEXT,
    "gender" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "unitId" TEXT,
    "turnoM" TEXT,
    "turnoT" TEXT,
    "turnoN" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VismedDoctor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VismedSpecialty" (
    "id" TEXT NOT NULL,
    "vismedId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "normalizedName" TEXT,

    CONSTRAINT "VismedSpecialty_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VismedInsurance" (
    "id" TEXT NOT NULL,
    "vismedId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "idConvenioTipo" INTEGER,
    "razaoSocial" TEXT,
    "cnpj" TEXT,
    "dataInicio" TEXT,
    "dataFinal" TEXT,
    "agendamentoOnline" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VismedInsurance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Doctor" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "specialty" TEXT,
    "crm" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Doctor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Appointment" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "doctorId" TEXT NOT NULL,
    "patientName" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "status" "AppointmentStatus" NOT NULL DEFAULT 'SCHEDULED',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Appointment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Service" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "duration" INTEGER,
    "price" DOUBLE PRECISION,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Service_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Insurance" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Insurance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Location" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "city" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Location_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncRun" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "totalRecords" INTEGER NOT NULL DEFAULT 0,
    "metrics" JSONB,

    CONSTRAINT "SyncRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncEvent" (
    "id" TEXT NOT NULL,
    "syncRunId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "externalId" TEXT,
    "message" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SyncEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT,
    "details" JSONB,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VismedProfessionalSpecialty" (
    "id" TEXT NOT NULL,
    "vismedDoctorId" TEXT NOT NULL,
    "vismedSpecialtyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VismedProfessionalSpecialty_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DoctoraliaDoctor" (
    "id" TEXT NOT NULL,
    "doctoraliaDoctorId" TEXT NOT NULL,
    "doctoraliaFacilityId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DoctoraliaDoctor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DoctoraliaService" (
    "id" TEXT NOT NULL,
    "doctoraliaServiceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "normalizedName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DoctoraliaService_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DoctoraliaInsuranceProvider" (
    "id" TEXT NOT NULL,
    "doctoraliaId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "normalizedName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DoctoraliaInsuranceProvider_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DoctoraliaInsurancePlan" (
    "id" TEXT NOT NULL,
    "doctoraliaId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DoctoraliaInsurancePlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DoctoraliaAddressService" (
    "id" TEXT NOT NULL,
    "doctoraliaAddressServiceId" TEXT NOT NULL,
    "doctoraliaAddressId" TEXT NOT NULL,
    "doctorId" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "price" DOUBLE PRECISION,
    "isPriceFrom" BOOLEAN NOT NULL DEFAULT false,
    "isVisible" BOOLEAN NOT NULL DEFAULT true,
    "description" TEXT,
    "defaultDuration" INTEGER,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DoctoraliaAddressService_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SpecialtyServiceMapping" (
    "id" TEXT NOT NULL,
    "vismedSpecialtyId" TEXT NOT NULL,
    "doctoraliaServiceId" TEXT NOT NULL,
    "matchType" "MatchType" NOT NULL,
    "confidenceScore" DOUBLE PRECISION NOT NULL,
    "requiresReview" BOOLEAN NOT NULL DEFAULT false,
    "reviewedAt" TIMESTAMP(3),
    "reviewedBy" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SpecialtyServiceMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MappingSynonym" (
    "id" TEXT NOT NULL,
    "termA" TEXT NOT NULL,
    "termB" TEXT NOT NULL,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MappingSynonym_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProfessionalUnifiedMapping" (
    "id" TEXT NOT NULL,
    "vismedDoctorId" TEXT NOT NULL,
    "doctoraliaDoctorId" TEXT NOT NULL,
    "specialtyServiceMappingId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProfessionalUnifiedMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookingSync" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "vismedDoctorId" TEXT,
    "doctoraliaDoctorId" TEXT,
    "doctoraliaBookingId" TEXT,
    "doctoraliaFacilityId" TEXT,
    "doctoraliaAddressId" TEXT,
    "origin" "BookingOrigin" NOT NULL,
    "status" "BookingSyncStatus" NOT NULL DEFAULT 'BOOKED',
    "patientName" TEXT NOT NULL,
    "patientSurname" TEXT,
    "patientPhone" TEXT,
    "patientEmail" TEXT,
    "patientCpf" TEXT,
    "patientBirthDate" TEXT,
    "patientGender" TEXT,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "duration" INTEGER,
    "serviceName" TEXT,
    "addressServiceId" TEXT,
    "notificationId" TEXT,
    "notificationName" TEXT,
    "rawPayload" JSONB,
    "syncedToVismed" BOOLEAN NOT NULL DEFAULT false,
    "syncedToDoctoralia" BOOLEAN NOT NULL DEFAULT false,
    "syncError" TEXT,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookingSync_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncJob" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "SyncJobStatus" NOT NULL DEFAULT 'PENDING',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "lastError" TEXT,
    "nextRunAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedAt" TIMESTAMP(3),
    "lockedBy" TEXT,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SyncJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "UserClinicRole_userId_clinicId_key" ON "UserClinicRole"("userId", "clinicId");

-- CreateIndex
CREATE UNIQUE INDEX "Mapping_clinicId_entityType_externalId_key" ON "Mapping"("clinicId", "entityType", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "Mapping_clinicId_entityType_vismedId_key" ON "Mapping"("clinicId", "entityType", "vismedId");

-- CreateIndex
CREATE UNIQUE INDEX "VismedUnit_vismedId_key" ON "VismedUnit"("vismedId");

-- CreateIndex
CREATE UNIQUE INDEX "VismedDoctor_vismedId_key" ON "VismedDoctor"("vismedId");

-- CreateIndex
CREATE UNIQUE INDEX "VismedSpecialty_vismedId_key" ON "VismedSpecialty"("vismedId");

-- CreateIndex
CREATE UNIQUE INDEX "VismedInsurance_vismedId_key" ON "VismedInsurance"("vismedId");

-- CreateIndex
CREATE UNIQUE INDEX "VismedProfessionalSpecialty_vismedDoctorId_vismedSpecialtyI_key" ON "VismedProfessionalSpecialty"("vismedDoctorId", "vismedSpecialtyId");

-- CreateIndex
CREATE UNIQUE INDEX "DoctoraliaDoctor_doctoraliaDoctorId_key" ON "DoctoraliaDoctor"("doctoraliaDoctorId");

-- CreateIndex
CREATE UNIQUE INDEX "DoctoraliaService_doctoraliaServiceId_key" ON "DoctoraliaService"("doctoraliaServiceId");

-- CreateIndex
CREATE UNIQUE INDEX "DoctoraliaInsuranceProvider_doctoraliaId_key" ON "DoctoraliaInsuranceProvider"("doctoraliaId");

-- CreateIndex
CREATE UNIQUE INDEX "DoctoraliaInsurancePlan_doctoraliaId_key" ON "DoctoraliaInsurancePlan"("doctoraliaId");

-- CreateIndex
CREATE UNIQUE INDEX "DoctoraliaAddressService_doctoraliaAddressServiceId_key" ON "DoctoraliaAddressService"("doctoraliaAddressServiceId");

-- CreateIndex
CREATE UNIQUE INDEX "SpecialtyServiceMapping_vismedSpecialtyId_doctoraliaService_key" ON "SpecialtyServiceMapping"("vismedSpecialtyId", "doctoraliaServiceId");

-- CreateIndex
CREATE UNIQUE INDEX "MappingSynonym_termA_termB_key" ON "MappingSynonym"("termA", "termB");

-- CreateIndex
CREATE UNIQUE INDEX "ProfessionalUnifiedMapping_vismedDoctorId_doctoraliaDoctorI_key" ON "ProfessionalUnifiedMapping"("vismedDoctorId", "doctoraliaDoctorId");

-- CreateIndex
CREATE UNIQUE INDEX "BookingSync_doctoraliaBookingId_key" ON "BookingSync"("doctoraliaBookingId");

-- CreateIndex
CREATE INDEX "BookingSync_clinicId_idx" ON "BookingSync"("clinicId");

-- CreateIndex
CREATE INDEX "BookingSync_doctoraliaBookingId_idx" ON "BookingSync"("doctoraliaBookingId");

-- CreateIndex
CREATE INDEX "BookingSync_startAt_idx" ON "BookingSync"("startAt");

-- CreateIndex
CREATE INDEX "BookingSync_clinicId_doctoraliaDoctorId_startAt_idx" ON "BookingSync"("clinicId", "doctoraliaDoctorId", "startAt");

-- CreateIndex
CREATE INDEX "SyncJob_status_nextRunAt_priority_idx" ON "SyncJob"("status", "nextRunAt", "priority");

-- CreateIndex
CREATE INDEX "SyncJob_clinicId_status_idx" ON "SyncJob"("clinicId", "status");

-- CreateIndex
CREATE INDEX "SyncJob_type_status_idx" ON "SyncJob"("type", "status");

-- AddForeignKey
ALTER TABLE "UserClinicRole" ADD CONSTRAINT "UserClinicRole_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserClinicRole" ADD CONSTRAINT "UserClinicRole_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationConnection" ADD CONSTRAINT "IntegrationConnection_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Mapping" ADD CONSTRAINT "Mapping_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VismedDoctor" ADD CONSTRAINT "VismedDoctor_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "VismedUnit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "Doctor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SyncRun" ADD CONSTRAINT "SyncRun_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SyncEvent" ADD CONSTRAINT "SyncEvent_syncRunId_fkey" FOREIGN KEY ("syncRunId") REFERENCES "SyncRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VismedProfessionalSpecialty" ADD CONSTRAINT "VismedProfessionalSpecialty_vismedDoctorId_fkey" FOREIGN KEY ("vismedDoctorId") REFERENCES "VismedDoctor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VismedProfessionalSpecialty" ADD CONSTRAINT "VismedProfessionalSpecialty_vismedSpecialtyId_fkey" FOREIGN KEY ("vismedSpecialtyId") REFERENCES "VismedSpecialty"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DoctoraliaInsurancePlan" ADD CONSTRAINT "DoctoraliaInsurancePlan_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "DoctoraliaInsuranceProvider"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DoctoraliaAddressService" ADD CONSTRAINT "DoctoraliaAddressService_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "DoctoraliaDoctor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DoctoraliaAddressService" ADD CONSTRAINT "DoctoraliaAddressService_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "DoctoraliaService"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SpecialtyServiceMapping" ADD CONSTRAINT "SpecialtyServiceMapping_vismedSpecialtyId_fkey" FOREIGN KEY ("vismedSpecialtyId") REFERENCES "VismedSpecialty"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SpecialtyServiceMapping" ADD CONSTRAINT "SpecialtyServiceMapping_doctoraliaServiceId_fkey" FOREIGN KEY ("doctoraliaServiceId") REFERENCES "DoctoraliaService"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProfessionalUnifiedMapping" ADD CONSTRAINT "ProfessionalUnifiedMapping_vismedDoctorId_fkey" FOREIGN KEY ("vismedDoctorId") REFERENCES "VismedDoctor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProfessionalUnifiedMapping" ADD CONSTRAINT "ProfessionalUnifiedMapping_doctoraliaDoctorId_fkey" FOREIGN KEY ("doctoraliaDoctorId") REFERENCES "DoctoraliaDoctor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProfessionalUnifiedMapping" ADD CONSTRAINT "ProfessionalUnifiedMapping_specialtyServiceMappingId_fkey" FOREIGN KEY ("specialtyServiceMappingId") REFERENCES "SpecialtyServiceMapping"("id") ON DELETE CASCADE ON UPDATE CASCADE;

