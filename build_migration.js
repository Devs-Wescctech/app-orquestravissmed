const fs = require('fs');

let content = fs.readFileSync('full_dump_utf8.json', 'utf8');
if (content.charCodeAt(0) === 0xFEFF) {
  content = content.slice(1);
}
const dump = JSON.parse(content);

let sql = `
-- MASTER MIGRATION SCRIPT FROM DUMP
BEGIN;

-- 1. Clinics
`;

// Helper for snake_case conversion and SQL safety
const toSnake = (s) => s.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
const escape = (val) => {
  if (val === null || val === undefined) return 'NULL';
  if (typeof val === 'string') return `'${val.replace(/'/g, "''")}'`;
  if (typeof val === 'object') return `'${JSON.stringify(val).replace(/'/g, "''")}'`;
  return val;
};

// --- CLINICS ---
const targetUserId = '4689bf73-07a4-475f-a615-192c7be77903'; // cristian.lima

if (dump.Clinic) {
  dump.Clinic.forEach(c => {
    sql += `INSERT INTO clinics (id, name, cnpj, timezone, active, address_street, address_neighborhood, address_number, address_city, address_state, address_zip_code, updated_at) 
VALUES (${escape(c.id)}, ${escape(c.name)}, ${escape(c.cnpj)}, ${escape(c.timezone)}, ${escape(c.active)}, ${escape(c.addressStreet)}, ${escape(c.addressNeighborhood)}, ${escape(c.addressNumber)}, ${escape(c.addressCity)}, ${escape(c.addressState)}, ${escape(c.addressZipCode)}, NOW())
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, cnpj = EXCLUDED.cnpj, active = EXCLUDED.active;

-- Link admin to this clinic
INSERT INTO user_clinic_roles (user_id, clinic_id, role)
VALUES ('${targetUserId}', ${escape(c.id)}, 'SUPER_ADMIN')
ON CONFLICT (user_id, clinic_id) DO UPDATE SET role = 'SUPER_ADMIN';
`;
  });
}

// --- INTEGRATION CONNECTIONS ---
// Note: In some old setups, integration data was in Clinic table? 
// No, check both dump.Clinic and dump.IntegrationConnection
if (dump.IntegrationConnection) {
  dump.IntegrationConnection.forEach(ic => {
    sql += `INSERT INTO integration_connections (id, clinic_id, provider, domain, client_id, client_secret, status, last_test_at)
VALUES (${escape(ic.id)}, ${escape(ic.clinicId)}, ${escape(ic.provider)}, ${escape(ic.domain)}, ${escape(ic.clientId)}, ${escape(ic.clientSecret)}, ${escape(ic.status)}, ${escape(ic.lastTestAt)})
ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, last_test_at = EXCLUDED.last_test_at;
`;
  });
}

// --- VISMED DATA ---
if (dump.VismedUnit) {
  dump.VismedUnit.forEach(u => {
    sql += `INSERT INTO vismed_units (id, vismed_id, cod_unidade, name, cnpj, city_name, is_active)
VALUES (${escape(u.id)}, ${escape(u.vismedId)}, ${escape(u.codUnidade)}, ${escape(u.name)}, ${escape(u.cnpj)}, ${escape(u.cityName)}, ${escape(u.isActive)})
ON CONFLICT (id) DO NOTHING;
`;
  });
}

if (dump.VismedDoctor) {
  dump.VismedDoctor.forEach(d => {
    sql += `INSERT INTO vismed_doctors (id, vismed_id, name, formal_name, cpf, document_number, document_type, gender, is_active, unit_id)
VALUES (${escape(d.id)}, ${escape(d.vismedId)}, ${escape(d.name)}, ${escape(d.formalName)}, ${escape(d.cpf)}, ${escape(d.documentNumber)}, ${escape(d.documentType)}, ${escape(d.gender)}, ${escape(d.isActive)}, ${escape(d.unitId)})
ON CONFLICT (id) DO NOTHING;
`;
  });
}

if (dump.VismedSpecialty) {
  dump.VismedSpecialty.forEach(s => {
    sql += `INSERT INTO vismed_specialties (id, vismed_id, name, normalized_name)
VALUES (${escape(s.id)}, ${escape(s.vismedId)}, ${escape(s.name)}, ${escape(s.normalizedName)})
ON CONFLICT (id) DO NOTHING;
`;
  });
}

// --- DOCTORALIA DATA ---
if (dump.DoctoraliaDoctor) {
  dump.DoctoraliaDoctor.forEach(d => {
    sql += `INSERT INTO doctoralia_doctors (id, doctoralia_doctor_id, doctoralia_facility_id, name, synced_at)
VALUES (${escape(d.id)}, ${escape(d.doctoraliaDoctorId)}, ${escape(d.doctoraliaFacilityId)}, ${escape(d.name)}, ${escape(d.syncedAt)})
ON CONFLICT (id) DO UPDATE SET synced_at = EXCLUDED.synced_at;
`;
  });
}

if (dump.DoctoraliaService) {
  dump.DoctoraliaService.forEach(s => {
    sql += `INSERT INTO doctoralia_services (id, doctoralia_service_id, name, normalized_name)
VALUES (${escape(s.id)}, ${escape(s.doctoraliaServiceId)}, ${escape(s.name)}, ${escape(s.normalizedName)})
ON CONFLICT (id) DO NOTHING;
`;
  });
}

if (dump.DoctoraliaAddressService) {
  dump.DoctoraliaAddressService.forEach(s => {
    sql += `INSERT INTO doctoralia_address_services (id, doctoralia_address_service_id, doctoralia_address_id, doctor_id, service_id, price, is_price_from, is_visible, description, default_duration)
VALUES (${escape(s.id)}, ${escape(s.doctoraliaAddressServiceId)}, ${escape(s.doctoraliaAddressId)}, ${escape(s.doctorId)}, ${escape(s.serviceId)}, ${escape(s.price)}, ${escape(s.isPriceFrom)}, ${escape(s.isVisible)}, ${escape(s.description)}, ${escape(s.defaultDuration)})
ON CONFLICT (id) DO NOTHING;
`;
  });
}

// --- MAPPINGS ---
if (dump.Mapping) {
  dump.Mapping.forEach(m => {
    sql += `INSERT INTO mappings (id, clinic_id, entity_type, vismed_id, external_id, status, conflict_data, last_sync_at)
VALUES (${escape(m.id)}, ${escape(m.clinicId)}, ${escape(m.entityType)}, ${escape(m.vismedId)}, ${escape(m.externalId)}, ${escape(m.status)}, ${escape(m.conflictData)}, ${escape(m.lastSyncAt)})
ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, last_sync_at = EXCLUDED.last_sync_at;
`;
  });
}

if (dump.SpecialtyServiceMapping) {
  dump.SpecialtyServiceMapping.forEach(sm => {
    sql += `INSERT INTO specialty_service_mappings (id, vismed_specialty_id, doctoralia_service_id, match_type, confidence_score, requires_review, reviewed_at, reviewed_by, is_active)
VALUES (${escape(sm.id)}, ${escape(sm.vismedSpecialtyId)}, ${escape(sm.doctoraliaServiceId)}, ${escape(sm.matchType)}, ${escape(sm.confidenceScore)}, ${escape(sm.requiresReview)}, ${escape(sm.reviewedAt)}, ${escape(sm.reviewedBy)}, ${escape(sm.isActive)})
ON CONFLICT (id) DO NOTHING;
`;
  });
}

if (dump.ProfessionalUnifiedMapping) {
  dump.ProfessionalUnifiedMapping.forEach(pum => {
    sql += `INSERT INTO professional_unified_mappings (id, vismed_doctor_id, doctoralia_doctor_id, specialty_service_mapping_id, is_active)
VALUES (${escape(pum.id)}, ${escape(pum.vismedDoctorId)}, ${escape(pum.doctoraliaDoctorId)}, ${escape(pum.specialtyServiceMappingId)}, ${escape(pum.isActive)})
ON CONFLICT (id) DO NOTHING;
`;
  });
}

sql += "\nCOMMIT;";

fs.writeFileSync('migration.sql', sql);
console.log('Migration SQL generated.');
