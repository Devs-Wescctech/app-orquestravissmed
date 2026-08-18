-- Task 206: escopar catálogo VisMed por empresa gestora (fim do ping-pongue 192↔3484)
--
-- 1) Nova coluna de escopo idEmpresaGestora (NULL = legado/ambíguo, será "reivindicado"
--    pelo sync escopado via vismedId — os catálogos das empresas são disjuntos na VisMed).
-- 2) Troca do unique global de vismedId pelo composto (idEmpresaGestora, vismedId).
-- 3) Índice parcial garante que registros ainda não escopados não dupliquem vismedId.
-- 4) Backfill FAIL-CLOSED: só atribui empresa quando TODOS os médicos vinculados à
--    especialidade pertencem (via Mapping → IntegrationConnection.clientId) a UMA única
--    empresa gestora. Casos ambíguos ficam NULL para o sync/claim resolver — nunca palpite.

ALTER TABLE "VismedSpecialty" ADD COLUMN "idEmpresaGestora" INTEGER;

DROP INDEX IF EXISTS "VismedSpecialty_vismedId_key";

CREATE UNIQUE INDEX "VismedSpecialty_idEmpresaGestora_vismedId_key"
    ON "VismedSpecialty"("idEmpresaGestora", "vismedId");

-- Registros legados sem escopo continuam únicos por vismedId até serem reivindicados.
CREATE UNIQUE INDEX "VismedSpecialty_vismedId_unscoped_key"
    ON "VismedSpecialty"("vismedId") WHERE "idEmpresaGestora" IS NULL;

CREATE INDEX "VismedSpecialty_normalizedName_idx" ON "VismedSpecialty"("normalizedName");

-- Backfill fail-closed: empresa derivada dos médicos vinculados (nunca por nome).
WITH spec_empresas AS (
    SELECT vps."vismedSpecialtyId" AS sid, (ic."clientId")::int AS emp
    FROM "VismedProfessionalSpecialty" vps
    JOIN "Mapping" m
        ON m."vismedId" = vps."vismedDoctorId" AND m."entityType" = 'DOCTOR'
    JOIN "IntegrationConnection" ic
        ON ic."clinicId" = m."clinicId"
       AND ic."provider" = 'vismed'
       AND ic."clientId" ~ '^[0-9]+$'
    GROUP BY 1, 2
),
unambiguous AS (
    SELECT sid, MIN(emp) AS emp
    FROM spec_empresas
    GROUP BY sid
    HAVING COUNT(DISTINCT emp) = 1
)
UPDATE "VismedSpecialty" s
SET "idEmpresaGestora" = u.emp
FROM unambiguous u
WHERE s."id" = u.sid;
