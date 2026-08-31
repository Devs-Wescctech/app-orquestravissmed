-- ============================================================================
-- AUDITORIA SOMENTE LEITURA — médicos dependentes apenas de PUM
--
-- Finalidade: inventariar pares (clinicId, VismedDoctor.id) que têm evidência
-- histórica de pertencimento ao tenant, ao menos um ProfessionalUnifiedMapping
-- ativo e NÃO possuem a autoridade clínica exigida pelo fluxo VisMed:
-- Mapping(entityType=DOCTOR, status=LINKED, externalId não vazio) apontando para
-- um DoctoraliaDoctor existente no catálogo local.
--
-- Não contém INSERT, UPDATE, DELETE, UPSERT, DDL ou chamada externa.
-- Não retorna nomes, documentos, pacientes, contatos, payloads ou credenciais.
-- Execute com psql -v ON_ERROR_STOP=1. ROLLBACK é obrigatório no final.
-- ============================================================================

\set ON_ERROR_STOP on
\pset pager off

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '30s';
SET LOCAL lock_timeout = '3s';
SET LOCAL idle_in_transaction_session_timeout = '60s';

-- --------------------------------------------------------------------------
-- Q1 — inventário individual por tenant
--
-- Evidência de pertencimento:
--   * BookingSync histórico do próprio par clinicId + VismedDoctor UUID; ou
--   * Mapping DOCTOR já existente para o par, ainda que inválido/não LINKED.
--
-- Uma facility armazenada em DoctoraliaDoctor/BookingSync é HISTÓRICA e aparece
-- somente como contagem/risco diagnóstico. Ela nunca autoriza o candidato.
--
-- candidate_class é deliberadamente preliminar: só uma validação Doctoralia
-- atual e tenant-safe por identificador forte pode produzir UNIQUE_CURRENT.
-- --------------------------------------------------------------------------
WITH
active_vismed_clinics AS (
  SELECT DISTINCT ic."clinicId"
  FROM "IntegrationConnection" ic
  JOIN "Clinic" c ON c.id = ic."clinicId"
  WHERE c.active = true
    AND ic.provider = 'vismed'
    AND ic.status <> 'disconnected'
    AND NULLIF(btrim(ic."clientId"), '') IS NOT NULL
),
tenant_evidence AS (
  SELECT DISTINCT bs."clinicId", bs."vismedDoctorId"
  FROM "BookingSync" bs
  JOIN active_vismed_clinics ac ON ac."clinicId" = bs."clinicId"
  WHERE bs."vismedDoctorId" IS NOT NULL
  UNION
  SELECT DISTINCT m."clinicId", m."vismedId"
  FROM "Mapping" m
  JOIN active_vismed_clinics ac ON ac."clinicId" = m."clinicId"
  WHERE m."entityType" = 'DOCTOR'
    AND m."vismedId" IS NOT NULL
),
current_mapping AS (
  SELECT te."clinicId", te."vismedDoctorId",
         m.id AS mapping_id, m.status AS mapping_status,
         NULLIF(btrim(m."externalId"), '') AS mapping_external_id,
         dd.id AS mapped_doctoralia_uuid
  FROM tenant_evidence te
  LEFT JOIN "Mapping" m
    ON m."clinicId" = te."clinicId"
   AND m."entityType" = 'DOCTOR'
   AND m."vismedId" = te."vismedDoctorId"
  LEFT JOIN "DoctoraliaDoctor" dd
    ON dd."doctoraliaDoctorId" = NULLIF(btrim(m."externalId"), '')
),
pum_rollup AS (
  SELECT pum."vismedDoctorId",
         count(*) AS active_pum_count,
         count(DISTINCT dd."doctoraliaDoctorId") AS pum_candidate_count,
         array_agg(DISTINCT pum.id ORDER BY pum.id) AS active_pum_ids,
         array_agg(DISTINCT dd."doctoraliaDoctorId"
                   ORDER BY dd."doctoraliaDoctorId") AS pum_candidate_ids,
         count(DISTINCT dd."doctoraliaFacilityId") AS historical_pum_facility_count
  FROM "ProfessionalUnifiedMapping" pum
  JOIN "DoctoraliaDoctor" dd ON dd.id = pum."doctoraliaDoctorId"
  WHERE pum."isActive" = true
  GROUP BY pum."vismedDoctorId"
),
booking_rollup AS (
  SELECT bs."clinicId", bs."vismedDoctorId",
         count(*) AS booking_total,
         count(*) FILTER (WHERE bs."createdAt" >= now() - interval '30 days')
           AS booking_recent_30d,
         count(*) FILTER (
           WHERE bs.origin = 'VISMED'
             AND bs.status IN ('PROCESSING', 'FAILED')
             AND bs."createdAt" >= now() - interval '30 days'
         )
           AS booking_pending_or_failed,
         count(*) FILTER (
           WHERE bs."startAt" >= now()
             AND bs.status NOT IN ('CANCELLED', 'NO_SHOW')
         ) AS booking_future_active,
         count(*) FILTER (WHERE bs.origin = 'VISMED') AS booking_origin_vismed,
         count(*) FILTER (
           WHERE bs."doctoraliaDoctorId" IS NOT NULL
             AND bs."doctoraliaDoctorId" <> ALL(pr.pum_candidate_ids)
         ) AS booking_outside_active_pum_candidates,
         count(DISTINCT bs."doctoraliaFacilityId")
           FILTER (WHERE bs."doctoraliaFacilityId" IS NOT NULL)
           AS historical_booking_facility_count
  FROM "BookingSync" bs
  JOIN pum_rollup pr ON pr."vismedDoctorId" = bs."vismedDoctorId"
  GROUP BY bs."clinicId", bs."vismedDoctorId", pr.pum_candidate_ids
),
eligible AS (
  SELECT cm."clinicId", vd.id AS "vismedDoctorId", vd."vismedId",
         cm.mapping_id, cm.mapping_status, cm.mapping_external_id,
         pr.active_pum_count, pr.pum_candidate_count,
         pr.active_pum_ids, pr.pum_candidate_ids,
         pr.historical_pum_facility_count,
         COALESCE(br.booking_total, 0) AS booking_total,
         COALESCE(br.booking_recent_30d, 0) AS booking_recent_30d,
         COALESCE(br.booking_pending_or_failed, 0) AS booking_pending_or_failed,
         COALESCE(br.booking_future_active, 0) AS booking_future_active,
         COALESCE(br.booking_origin_vismed, 0) AS booking_origin_vismed,
         COALESCE(br.booking_outside_active_pum_candidates, 0)
           AS booking_outside_active_pum_candidates,
         COALESCE(br.historical_booking_facility_count, 0)
           AS historical_booking_facility_count,
         count(*) OVER (PARTITION BY vd.id) AS clinic_count_for_vismed_doctor
  FROM current_mapping cm
  JOIN "VismedDoctor" vd ON vd.id = cm."vismedDoctorId"
  JOIN pum_rollup pr ON pr."vismedDoctorId" = vd.id
  LEFT JOIN booking_rollup br
    ON br."clinicId" = cm."clinicId"
   AND br."vismedDoctorId" = vd.id
  WHERE vd."isActive" = true
    AND NOT (
      cm.mapping_status = 'LINKED'
      AND cm.mapping_external_id IS NOT NULL
      AND cm.mapped_doctoralia_uuid IS NOT NULL
    )
)
SELECT "clinicId", "vismedDoctorId", "vismedId",
       mapping_id, mapping_status, mapping_external_id,
       active_pum_count, pum_candidate_count,
       active_pum_ids, pum_candidate_ids,
       historical_pum_facility_count, historical_booking_facility_count,
       booking_total, booking_recent_30d, booking_pending_or_failed,
       booking_future_active, booking_origin_vismed,
       booking_outside_active_pum_candidates,
       CASE WHEN clinic_count_for_vismed_doctor > 1
            THEN 'MULTI_CLINIC_REQUIRES_TENANT_VALIDATION'
            ELSE 'SINGLE_CLINIC_REQUIRES_TENANT_VALIDATION'
       END AS tenant_scope_class,
       CASE WHEN active_pum_count > 1 OR pum_candidate_count > 1
            THEN 'MULTIPLE_PUMS_DIAGNOSTIC_RISK'
            ELSE 'ONE_PUM_DIAGNOSTIC_ONLY'
       END AS pum_risk,
       'CURRENT_STRONG_IDENTIFIER_VALIDATION_REQUIRED' AS candidate_class
FROM eligible
ORDER BY "clinicId", "vismedId", "vismedDoctorId";

-- --------------------------------------------------------------------------
-- Q2 — comparação com o baseline auditado, sem forçar contagens
-- Esperado historicamente: 11 médicos distintos; 8 + 3 nos tenants indicados.
-- Toda diferença é STATE_CHANGED_SINCE_BASELINE e bloqueia remediação.
-- --------------------------------------------------------------------------
WITH
baseline("clinicId", expected_distinct_doctors) AS (
  VALUES
    ('37baa82a-e625-4a1b-ae1d-158ad75037f1', 8::bigint),
    ('e87ca02e-1f7a-4217-92bb-4572069dbf31', 3::bigint)
),
active_vismed_clinics AS (
  SELECT DISTINCT ic."clinicId"
  FROM "IntegrationConnection" ic
  JOIN "Clinic" c ON c.id = ic."clinicId"
  WHERE c.active = true AND ic.provider = 'vismed'
    AND ic.status <> 'disconnected'
    AND NULLIF(btrim(ic."clientId"), '') IS NOT NULL
),
tenant_evidence AS (
  SELECT DISTINCT bs."clinicId", bs."vismedDoctorId"
  FROM "BookingSync" bs JOIN active_vismed_clinics ac
    ON ac."clinicId" = bs."clinicId"
  WHERE bs."vismedDoctorId" IS NOT NULL
  UNION
  SELECT DISTINCT m."clinicId", m."vismedId"
  FROM "Mapping" m JOIN active_vismed_clinics ac
    ON ac."clinicId" = m."clinicId"
  WHERE m."entityType" = 'DOCTOR' AND m."vismedId" IS NOT NULL
),
eligible AS (
  SELECT te."clinicId", te."vismedDoctorId"
  FROM tenant_evidence te
  JOIN "VismedDoctor" vd ON vd.id = te."vismedDoctorId" AND vd."isActive" = true
  WHERE EXISTS (
    SELECT 1 FROM "ProfessionalUnifiedMapping" pum
    WHERE pum."vismedDoctorId" = te."vismedDoctorId" AND pum."isActive" = true
  )
  AND NOT EXISTS (
    SELECT 1
    FROM "Mapping" m
    JOIN "DoctoraliaDoctor" dd
      ON dd."doctoraliaDoctorId" = NULLIF(btrim(m."externalId"), '')
    WHERE m."clinicId" = te."clinicId"
      AND m."entityType" = 'DOCTOR'
      AND m."vismedId" = te."vismedDoctorId"
      AND m.status = 'LINKED'
      AND NULLIF(btrim(m."externalId"), '') IS NOT NULL
  )
),
actual AS (
  SELECT "clinicId", count(DISTINCT "vismedDoctorId") AS actual_distinct_doctors
  FROM eligible GROUP BY "clinicId"
),
comparison AS (
  SELECT COALESCE(b."clinicId", a."clinicId") AS "clinicId",
         COALESCE(b.expected_distinct_doctors, 0) AS expected_distinct_doctors,
         COALESCE(a.actual_distinct_doctors, 0) AS actual_distinct_doctors
  FROM baseline b FULL OUTER JOIN actual a USING ("clinicId")
)
SELECT "clinicId", expected_distinct_doctors, actual_distinct_doctors,
       actual_distinct_doctors - expected_distinct_doctors AS delta,
       CASE WHEN actual_distinct_doctors = expected_distinct_doctors
            THEN 'BASELINE_MATCH'
            ELSE 'STATE_CHANGED_SINCE_BASELINE'
       END AS baseline_status
FROM comparison
WHERE expected_distinct_doctors <> 0 OR actual_distinct_doctors <> 0
ORDER BY "clinicId";

-- Resumo global separado: reutiliza EXATAMENTE a população eligible acima e
-- restringe o baseline às duas clínicas auditadas. Conta médicos distintos,
-- não pares tenant+médico.
WITH
target_clinics("clinicId") AS (
  VALUES ('37baa82a-e625-4a1b-ae1d-158ad75037f1'),
         ('e87ca02e-1f7a-4217-92bb-4572069dbf31')
),
active_vismed_clinics AS (
  SELECT DISTINCT ic."clinicId"
  FROM "IntegrationConnection" ic
  JOIN "Clinic" c ON c.id = ic."clinicId"
  WHERE c.active = true AND ic.provider = 'vismed'
    AND ic.status <> 'disconnected'
    AND NULLIF(btrim(ic."clientId"), '') IS NOT NULL
),
tenant_evidence AS (
  SELECT DISTINCT bs."clinicId", bs."vismedDoctorId"
  FROM "BookingSync" bs JOIN active_vismed_clinics ac
    ON ac."clinicId" = bs."clinicId"
  WHERE bs."vismedDoctorId" IS NOT NULL
  UNION
  SELECT DISTINCT m."clinicId", m."vismedId"
  FROM "Mapping" m JOIN active_vismed_clinics ac
    ON ac."clinicId" = m."clinicId"
  WHERE m."entityType" = 'DOCTOR' AND m."vismedId" IS NOT NULL
),
eligible AS (
  SELECT te."clinicId", te."vismedDoctorId"
  FROM tenant_evidence te
  JOIN "VismedDoctor" vd ON vd.id = te."vismedDoctorId" AND vd."isActive" = true
  WHERE EXISTS (
    SELECT 1 FROM "ProfessionalUnifiedMapping" pum
    WHERE pum."vismedDoctorId" = te."vismedDoctorId" AND pum."isActive" = true
  )
  AND NOT EXISTS (
    SELECT 1 FROM "Mapping" m
    JOIN "DoctoraliaDoctor" dd
      ON dd."doctoraliaDoctorId" = NULLIF(btrim(m."externalId"), '')
    WHERE m."clinicId" = te."clinicId"
      AND m."entityType" = 'DOCTOR'
      AND m."vismedId" = te."vismedDoctorId"
      AND m.status = 'LINKED'
      AND NULLIF(btrim(m."externalId"), '') IS NOT NULL
  )
),
pairs AS (
  SELECT e.*
  FROM eligible e JOIN target_clinics tc USING ("clinicId")
)
SELECT 11::bigint AS baseline_distinct_doctors,
       count(DISTINCT "vismedDoctorId") AS actual_distinct_doctors,
       count(*) AS actual_tenant_doctor_pairs,
       CASE WHEN count(DISTINCT "vismedDoctorId") = 11
            THEN 'BASELINE_MATCH'
            ELSE 'STATE_CHANGED_SINCE_BASELINE'
       END AS baseline_status
FROM pairs;

-- --------------------------------------------------------------------------
-- Q3 — seção específica obrigatória: clínica e profissional VisMed 6906.
-- Retorna zero linhas se o estado mudou ou se ele já ganhou autoridade válida.
-- --------------------------------------------------------------------------
WITH target AS (
  SELECT 'e87ca02e-1f7a-4217-92bb-4572069dbf31'::text AS "clinicId",
         vd.id AS "vismedDoctorId", vd."vismedId"
  FROM "VismedDoctor" vd
  WHERE vd."vismedId" = 6906
)
SELECT t."clinicId", t."vismedDoctorId", t."vismedId",
       m.id AS mapping_id, m.status AS mapping_status,
       NULLIF(btrim(m."externalId"), '') AS mapping_external_id,
       count(DISTINCT pum.id) FILTER (WHERE pum."isActive") AS active_pum_count,
       count(DISTINCT dd."doctoraliaDoctorId") FILTER (WHERE pum."isActive")
         AS pum_candidate_count,
       array_agg(DISTINCT dd."doctoraliaDoctorId"
                 ORDER BY dd."doctoraliaDoctorId")
         FILTER (WHERE pum."isActive") AS pum_candidate_ids,
       count(DISTINCT bs.id) AS booking_total,
       count(DISTINCT bs.id) FILTER (
         WHERE bs.origin = 'VISMED'
           AND bs.status IN ('PROCESSING', 'FAILED')
           AND bs."createdAt" >= now() - interval '30 days'
       ) AS booking_pending_or_failed,
       'CURRENT_STRONG_IDENTIFIER_VALIDATION_REQUIRED' AS candidate_class
FROM target t
LEFT JOIN "Mapping" m
  ON m."clinicId" = t."clinicId"
 AND m."entityType" = 'DOCTOR'
 AND m."vismedId" = t."vismedDoctorId"
LEFT JOIN "ProfessionalUnifiedMapping" pum
  ON pum."vismedDoctorId" = t."vismedDoctorId"
LEFT JOIN "DoctoraliaDoctor" dd ON dd.id = pum."doctoraliaDoctorId"
LEFT JOIN "BookingSync" bs
  ON bs."clinicId" = t."clinicId"
 AND bs."vismedDoctorId" = t."vismedDoctorId"
WHERE EXISTS (
  SELECT 1 FROM "ProfessionalUnifiedMapping" p
  WHERE p."vismedDoctorId" = t."vismedDoctorId" AND p."isActive" = true
)
AND NOT EXISTS (
  SELECT 1 FROM "Mapping" vm JOIN "DoctoraliaDoctor" vdd
    ON vdd."doctoraliaDoctorId" = NULLIF(btrim(vm."externalId"), '')
  WHERE vm."clinicId" = t."clinicId" AND vm."entityType" = 'DOCTOR'
    AND vm."vismedId" = t."vismedDoctorId" AND vm.status = 'LINKED'
    AND NULLIF(btrim(vm."externalId"), '') IS NOT NULL
)
GROUP BY t."clinicId", t."vismedDoctorId", t."vismedId",
         m.id, m.status, m."externalId";

-- --------------------------------------------------------------------------
-- Q4 — manifesto técnico do cohort BookingSync, sem dados de paciente.
--
-- Definição canônica do cohort, repetida sem alteração na Q5:
--   * origin = VISMED;
--   * vismedDoctorId e doctoraliaDoctorId armazenados não nulos;
--   * sem autoridade clínica DOCTOR + LINKED válida; OU
--   * doctoraliaDoctorId armazenado diverge de todas as autoridades válidas.
--
-- Esta saída DEVE ser preservada antes de qualquer remediação, junto com
-- timestamp, contagem e checksum do arquivo de saída. Ela é a chave imutável do
-- lote histórico futuro: depois que mappings forem corrigidos, não reconstruir
-- o cohort pela condição corrente. O cohort serve apenas para triagem; não
-- autoriza alteração nem reprocessamento.
-- --------------------------------------------------------------------------
WITH
valid_clinic_authority AS (
  SELECT m."clinicId", m."vismedId" AS "vismedDoctorId",
         array_agg(DISTINCT NULLIF(btrim(m."externalId"), '')
                   ORDER BY NULLIF(btrim(m."externalId"), ''))
           AS authorized_doctoralia_ids
  FROM "Mapping" m
  JOIN "DoctoraliaDoctor" dd
    ON dd."doctoraliaDoctorId" = NULLIF(btrim(m."externalId"), '')
  WHERE m."entityType" = 'DOCTOR'
    AND m.status = 'LINKED'
    AND m."vismedId" IS NOT NULL
    AND NULLIF(btrim(m."externalId"), '') IS NOT NULL
  GROUP BY m."clinicId", m."vismedId"
),
historical_contaminated_cohort AS (
  SELECT bs.id AS booking_sync_id, bs."clinicId", bs."vismedDoctorId",
         bs.origin, bs.status, bs."startAt",
         bs."doctoraliaDoctorId", bs."doctoraliaFacilityId",
         CASE
           WHEN vca."vismedDoctorId" IS NULL
             THEN 'NO_VALID_CURRENT_CLINIC_AUTHORITY'
           ELSE 'STORED_DOCTOR_DIVERGES_FROM_CURRENT_AUTHORITY'
         END AS contamination_reason
  FROM "BookingSync" bs
  LEFT JOIN valid_clinic_authority vca
    ON vca."clinicId" = bs."clinicId"
   AND vca."vismedDoctorId" = bs."vismedDoctorId"
  WHERE bs.origin = 'VISMED'
    AND bs."vismedDoctorId" IS NOT NULL
    AND bs."doctoraliaDoctorId" IS NOT NULL
    AND (
      vca."vismedDoctorId" IS NULL
      OR NOT (
        bs."doctoraliaDoctorId" = ANY(vca.authorized_doctoralia_ids)
      )
    )
)
SELECT booking_sync_id, "clinicId", "vismedDoctorId", origin, status,
       contamination_reason,
       ("startAt" >= now()) AS is_future,
       true AS has_doctoralia_doctor_id,
       ("doctoraliaFacilityId" IS NOT NULL) AS has_doctoralia_facility_id
FROM historical_contaminated_cohort
ORDER BY "clinicId", "vismedDoctorId", booking_sync_id;

-- Q5 — resumo da mesma definição canônica da Q4.
-- PostgreSQL limita o escopo de uma CTE a uma instrução; por isso as CTEs
-- abaixo repetem literalmente os critérios da Q4 para produzir uma segunda
-- saída sem criar view ou tabela temporária.
WITH
valid_clinic_authority AS (
  SELECT m."clinicId", m."vismedId" AS "vismedDoctorId",
         array_agg(DISTINCT NULLIF(btrim(m."externalId"), '')
                   ORDER BY NULLIF(btrim(m."externalId"), ''))
           AS authorized_doctoralia_ids
  FROM "Mapping" m
  JOIN "DoctoraliaDoctor" dd
    ON dd."doctoraliaDoctorId" = NULLIF(btrim(m."externalId"), '')
  WHERE m."entityType" = 'DOCTOR'
    AND m.status = 'LINKED'
    AND m."vismedId" IS NOT NULL
    AND NULLIF(btrim(m."externalId"), '') IS NOT NULL
  GROUP BY m."clinicId", m."vismedId"
),
historical_contaminated_cohort AS (
  SELECT bs.id AS booking_sync_id, bs."clinicId", bs."vismedDoctorId",
         bs.origin, bs.status, bs."startAt",
         bs."doctoraliaDoctorId", bs."doctoraliaFacilityId",
         CASE
           WHEN vca."vismedDoctorId" IS NULL
             THEN 'NO_VALID_CURRENT_CLINIC_AUTHORITY'
           ELSE 'STORED_DOCTOR_DIVERGES_FROM_CURRENT_AUTHORITY'
         END AS contamination_reason
  FROM "BookingSync" bs
  LEFT JOIN valid_clinic_authority vca
    ON vca."clinicId" = bs."clinicId"
   AND vca."vismedDoctorId" = bs."vismedDoctorId"
  WHERE bs.origin = 'VISMED'
    AND bs."vismedDoctorId" IS NOT NULL
    AND bs."doctoraliaDoctorId" IS NOT NULL
    AND (
      vca."vismedDoctorId" IS NULL
      OR NOT (
        bs."doctoraliaDoctorId" = ANY(vca.authorized_doctoralia_ids)
      )
    )
)
SELECT 931::bigint AS historical_baseline,
       count(*) AS current_total,
       count(*) AS origin_vismed,
       0::bigint AS origin_doctoralia,
       count(*) FILTER (WHERE status = 'BOOKED') AS status_booked,
       count(*) FILTER (WHERE status = 'CONFIRMED') AS status_confirmed,
       count(*) FILTER (WHERE status = 'CANCELLED') AS status_cancelled,
       count(*) FILTER (WHERE status = 'MOVED') AS status_moved,
       count(*) FILTER (WHERE status = 'NO_SHOW') AS status_no_show,
       count(*) FILTER (WHERE status = 'FAILED') AS status_failed,
       count(*) FILTER (WHERE status = 'PROCESSING') AS status_processing,
       count(*) FILTER (WHERE "startAt" >= now()) AS future_total,
       count(*) FILTER (
         WHERE contamination_reason = 'NO_VALID_CURRENT_CLINIC_AUTHORITY'
       ) AS no_valid_authority_total,
       count(*) FILTER (
         WHERE contamination_reason =
           'STORED_DOCTOR_DIVERGES_FROM_CURRENT_AUTHORITY'
       ) AS divergent_authority_total,
       CASE WHEN count(*) = 931 THEN 'BASELINE_MATCH'
            ELSE 'STATE_CHANGED_SINCE_BASELINE'
       END AS baseline_status,
       'OUT_OF_SCOPE_FOR_ACTIVE_MAPPING_REMEDIATION' AS treatment
FROM historical_contaminated_cohort;

ROLLBACK;
