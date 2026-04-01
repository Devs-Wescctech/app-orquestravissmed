const fs = require('fs');

const models = `
model VismedProfessionalSpecialty {
  id                String          @id @default(uuid())
  vismedDoctorId    String
  vismedSpecialtyId String
  createdAt         DateTime        @default(now())

  doctor            VismedDoctor    @relation(fields: [vismedDoctorId], references: [id], onDelete: Cascade)
  specialty         VismedSpecialty @relation(fields: [vismedSpecialtyId], references: [id], onDelete: Cascade)

  @@unique([vismedDoctorId, vismedSpecialtyId])
}

model DoctoraliaDoctor {
  id                   String   @id @default(uuid())
  doctoraliaDoctorId   String   @unique
  doctoraliaFacilityId String
  name                 String
  syncedAt             DateTime @default(now())
  createdAt            DateTime @default(now())
  updatedAt            DateTime @updatedAt

  addressServices      DoctoraliaAddressService[]
  unifiedMappings      ProfessionalUnifiedMapping[]
}

model DoctoraliaService {
  id                   String   @id @default(uuid())
  doctoraliaServiceId  String   @unique
  name                 String
  normalizedName       String?
  createdAt            DateTime @default(now())
  updatedAt            DateTime @updatedAt

  addressServices      DoctoraliaAddressService[]
  mappings             SpecialtyServiceMapping[]
}

model DoctoraliaAddressService {
  id                            String   @id @default(uuid())
  doctoraliaAddressServiceId    String   @unique
  doctoraliaAddressId           String
  doctorId                      String
  serviceId                     String
  price                         Float?
  isPriceFrom                   Boolean  @default(false)
  isVisible                     Boolean  @default(true)
  description                   String?
  defaultDuration               Int?
  syncedAt                      DateTime @default(now())
  createdAt                     DateTime @default(now())
  updatedAt                     DateTime @updatedAt

  doctor                        DoctoraliaDoctor  @relation(fields: [doctorId], references: [id], onDelete: Cascade)
  service                       DoctoraliaService @relation(fields: [serviceId], references: [id], onDelete: Cascade)
}

enum MatchType {
  EXACT
  APPROXIMATE
  SYNONYM
  MANUAL
}

model SpecialtyServiceMapping {
  id                   String   @id @default(uuid())
  vismedSpecialtyId    String
  doctoraliaServiceId  String
  matchType            MatchType
  confidenceScore      Float
  requiresReview       Boolean  @default(false)
  reviewedAt           DateTime?
  reviewedBy           String?
  isActive             Boolean  @default(true)
  createdAt            DateTime @default(now())
  updatedAt            DateTime @updatedAt

  vismedSpecialty      VismedSpecialty    @relation(fields: [vismedSpecialtyId], references: [id], onDelete: Cascade)
  doctoraliaService    DoctoraliaService  @relation(fields: [doctoraliaServiceId], references: [id], onDelete: Cascade)

  unifiedMappings      ProfessionalUnifiedMapping[]

  @@unique([vismedSpecialtyId, doctoraliaServiceId])
}

model MappingSynonym {
  id        String   @id @default(uuid())
  termA     String
  termB     String
  createdBy String?
  createdAt DateTime @default(now())

  @@unique([termA, termB])
}

model ProfessionalUnifiedMapping {
  id                         String   @id @default(uuid())
  vismedDoctorId             String
  doctoraliaDoctorId         String
  specialtyServiceMappingId  String
  isActive                   Boolean  @default(true)
  createdAt                  DateTime @default(now())
  updatedAt                  DateTime @updatedAt

  vismedDoctor               VismedDoctor            @relation(fields: [vismedDoctorId], references: [id], onDelete: Cascade)
  doctoraliaDoctor           DoctoraliaDoctor        @relation(fields: [doctoraliaDoctorId], references: [id], onDelete: Cascade)
  mapping                    SpecialtyServiceMapping @relation(fields: [specialtyServiceMappingId], references: [id], onDelete: Cascade)

  @@unique([vismedDoctorId, doctoraliaDoctorId, specialtyServiceMappingId])
}
`;

fs.appendFileSync('prisma/schema.prisma', models, 'utf8');
console.log('Appended successfully');
