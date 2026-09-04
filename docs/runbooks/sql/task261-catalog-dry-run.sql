-- Task 261: validação somente leitura. Não contém dados pessoais/credenciais.
\set ON_ERROR_STOP on
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '30s';
SET LOCAL lock_timeout = '3s';

-- Conexões Doctoralia ambíguas: qualquer linha bloqueia publicação/matching.
SELECT "clinicId", count(*) AS doctoralia_connection_count
FROM "IntegrationConnection"
WHERE provider = 'doctoralia'
GROUP BY "clinicId"
HAVING count(*) <> 1
ORDER BY "clinicId";

-- Integridade e frescor das gerações sem expor payload de médico.
SELECT g."clinicId", g."connectionId", g."catalogScopeVersion",
       ic."catalogScopeVersion" AS current_scope_version,
       g."publishedAt", g."expiresAt",
       g."facilityCount", g."doctorCount",
       count(m.id) AS actual_member_count,
       CASE
         WHEN g."catalogScopeVersion" <> ic."catalogScopeVersion" THEN 'STALE_SCOPE'
         WHEN g."expiresAt" <= now() THEN 'EXPIRED'
         WHEN g."doctorCount" <> count(m.id) THEN 'COUNT_MISMATCH'
         ELSE 'VALID'
       END AS validation
FROM "DoctoraliaCatalogGeneration" g
JOIN "IntegrationConnection" ic ON ic.id = g."connectionId" AND ic."clinicId" = g."clinicId"
LEFT JOIN "DoctoraliaCatalogMember" m ON m."generationId" = g.id
GROUP BY g.id, ic."catalogScopeVersion"
ORDER BY g."clinicId", g."publishedAt" DESC;

-- Duplicidade externa entre facilities é informativa; matching deduplica pelo
-- médico e exige exatamente um candidato forte.
SELECT "generationId", "doctoraliaExternalId",
       count(DISTINCT "facilityId") AS facility_count
FROM "DoctoraliaCatalogMember"
GROUP BY "generationId", "doctoraliaExternalId"
HAVING count(DISTINCT "facilityId") > 1
ORDER BY "generationId", "doctoraliaExternalId";

ROLLBACK;