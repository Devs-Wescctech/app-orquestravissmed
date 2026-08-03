-- CreateTable
CREATE TABLE "SlotPushState" (
    "id" TEXT NOT NULL,
    "doctoraliaDoctorId" TEXT NOT NULL,
    "addressId" TEXT NOT NULL,
    "availabilityHash" TEXT NOT NULL,
    "lastSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SlotPushState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SlotPushState_doctoraliaDoctorId_addressId_key" ON "SlotPushState"("doctoraliaDoctorId", "addressId");
