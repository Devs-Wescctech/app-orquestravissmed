-- ============================================================================
-- CORREÇÃO TRANSACIONAL (via psql) — contaminação de DoctoraliaService.doctoraliaServiceId
--   por address_service_id
--
-- Tradução SQL auditável do script apps/api/scripts/fix-service-dict-ids.js
-- (SHA-256 de referência do script JS auditado:
--   a98f588f78762e9e1d5a0bd372676af1aa70ab57004dccbbb955bb14af4e771c)
-- para execução direta no psql de produção, com o container <api> PARADO.
--
-- Runbook: docs/runbooks/correcao-ids-contaminados.md (baseline 34/126, SAFE_MERGE only)
-- Adendo:  seção 13 do runbook ("Via SQL direta — container parado") — Gate 2 redefinido.
--
-- COMO EXECUTAR (após todos os gates do runbook, incl. pausa/quiescência/backup):
--   docker exec -i <pg> psql -U <user> -d <db> -v ON_ERROR_STOP=1 \
--     -f - < docs/runbooks/sql/fix-service-dict-ids-transacional.sql 2>&1 | tee fix_dict_sql_run_<TS>.log
--   (ou \i dentro de uma sessão psql interativa — a sessão fica ABERTA no fim,
--    aguardando COMMIT/ROLLBACK manual; ver bloco final)
--
-- PROPRIEDADES DE SEGURANÇA:
--   * Bloco único BEGIN ... (sem COMMIT). O COMMIT é o gate humano
--     (`AUTORIZAÇÃO HUMANA PARA EXECUTAR` adaptado — seção 13 do runbook).
--   * TODOS os pré-checks do Gate 1 (P1/P2/P3/P4/P5/P5b) são revalidados DENTRO
--     da transação; qualquer divergência → RAISE EXCEPTION → transação inteira aborta.
--   * Executa SOMENTE o ramo SAFE_MERGE. Divergências INTENCIONAIS vs o script JS:
--       (D1) ramo NO_MATCH do script (delete com cascade, linhas 53-61 do JS)
--            → aqui vira RAISE EXCEPTION (abort);
--       (D2) ramo EXISTING_CORRECT_MAPPING / colisão do script (altera mapping
--            preexistente e deleta o contaminado, linhas 69-85 do JS)
--            → aqui vira RAISE EXCEPTION (abort);
--       (D3) fallback de normalizedName por normalização NFD (linhas 41-42 do JS)
--            NÃO é replicado (strip de acentos não é determinístico em SQL puro sem
--            extensão unaccent) → qualquer entrada falsa com normalizedName NULL
--            vira RAISE EXCEPTION (abort);
--       (D4) desempate determinístico: o JS ordena candidatos só por createdAt asc;
--            aqui a ordenação é (createdAt asc, id asc) para determinismo total.
--            Com P5 AMBIGUOUS=0 nos 34 mapeados, não há efeito prático;
--       (D5) dedup de pivots compostos: o clash-check iterativo do JS (linhas
--            118-143) é substituído por dedup determinística em conjunto
--            (mesmo resultado final: 1 pivot por link id puro);
--       (D6) sem COMMIT no arquivo — parada obrigatória para decisão humana.
--   * PROPRIEDADE DE SEGURANÇA (não é divergência de semântica de mutação):
--     gates pré e validações pós rodam DENTRO da transação (falha → abort
--     automático, nada é persistido — não confundir com o restore da seção 3.1
--     do runbook, que aqui nunca é necessário porque nada foi commitado).
-- ============================================================================

\set ON_ERROR_STOP on
\timing on

BEGIN;

-- Trava defensiva: serializa contra qualquer writer residual (com o container
-- parado e a quiescência confirmada, não deve haver nenhum).
LOCK TABLE "DoctoraliaService", "DoctoraliaAddressService",
           "SpecialtyServiceMapping", "ProfessionalUnifiedMapping"
  IN SHARE ROW EXCLUSIVE MODE;

-- ----------------------------------------------------------------------------
-- ETAPA 0 — Conjuntos de trabalho (temp tables; morrem no ROLLBACK/COMMIT)
--
-- Conjunto fake usado: forma (b) do runbook — fake_from_composite (3º componente
-- dos pivots compostos), que é EXATAMENTE o gatilho do script JS (linhas 20-30).
-- A definição oficial (forma a+b, CTE suspect_ids) é usada nos asserts P1/P2:
-- P2.fora_do_gatilho = 0 (revalidado abaixo) prova que os dois conjuntos
-- coincidem para todos os mappings contaminados.
-- ----------------------------------------------------------------------------

-- fake_from_composite (runbook seção 1; JS linhas 25-29)
CREATE TEMP TABLE _fake_ids ON COMMIT DROP AS
SELECT DISTINCT split_part("doctoraliaAddressServiceId", '_', 3) AS fake_id
FROM "DoctoraliaAddressService"
WHERE "doctoraliaAddressServiceId" LIKE '%\_%' ESCAPE '\'
  AND array_length(string_to_array("doctoraliaAddressServiceId", '_'), 1) = 3;

-- suspect_ids (definição oficial, duas formas — runbook seção 1)
CREATE TEMP TABLE _suspect_ids ON COMMIT DROP AS
SELECT "doctoraliaAddressServiceId" AS sid FROM "DoctoraliaAddressService"
WHERE "doctoraliaAddressServiceId" NOT LIKE '%\_%' ESCAPE '\'
UNION
SELECT fake_id FROM _fake_ids;

-- Entradas falsas do dicionário (JS linhas 33-37)
CREATE TEMP TABLE _fake_services ON COMMIT DROP AS
SELECT ds.id, ds."doctoraliaServiceId", ds.name, ds."normalizedName"
FROM "DoctoraliaService" ds
WHERE ds."doctoraliaServiceId" IN (SELECT fake_id FROM _fake_ids);

-- Plano de merge por entrada falsa: candidato correto = mesmo normalizedName,
-- id diferente, doctoraliaServiceId fora do conjunto fake, createdAt asc
-- (JS linhas 44-51; desempate extra por id — divergência D4).
CREATE TEMP TABLE _merge_plan ON COMMIT DROP AS
SELECT f.id            AS fake_uuid,
       f."doctoraliaServiceId" AS fake_ext_id,
       f.name          AS fake_name,
       f."normalizedName",
       cand.id         AS correct_uuid,
       cand.ext_id     AS correct_ext_id,
       cand.n_cands    AS candidate_count
FROM _fake_services f
LEFT JOIN LATERAL (
  SELECT c.id, c."doctoraliaServiceId" AS ext_id,
         count(*) OVER () AS n_cands
  FROM "DoctoraliaService" c
  WHERE c."normalizedName" = f."normalizedName"
    AND c.id <> f.id
    AND c."doctoraliaServiceId" NOT IN (SELECT fake_id FROM _fake_ids)
  ORDER BY c."createdAt" ASC, c.id ASC
  LIMIT 1
) cand ON true;

-- Plano de merge com a exclusão OFICIAL (suspect_ids, forma a+b) — usado SOMENTE
-- para o assert de equivalência do Gate 1 (a mutação usa _merge_plan, que replica
-- o gatilho do script JS). Garante que o candidato escolhido pela semântica do JS
-- é idêntico ao da definição oficial do runbook (nota da seção 1).
CREATE TEMP TABLE _merge_plan_official ON COMMIT DROP AS
SELECT f.id AS fake_uuid,
       cand.id AS correct_uuid,
       cand.n_cands AS candidate_count
FROM _fake_services f
LEFT JOIN LATERAL (
  SELECT c.id, count(*) OVER () AS n_cands
  FROM "DoctoraliaService" c
  WHERE c."normalizedName" = f."normalizedName"
    AND c.id <> f.id
    AND c."doctoraliaServiceId" NOT IN (SELECT sid FROM _suspect_ids)
  ORDER BY c."createdAt" ASC, c.id ASC
  LIMIT 1
) cand ON true;

-- Mappings contaminados (os 34) + flag de restauração de auto-aprovação
-- (JS linhas 66-68: restore só se invalidReason preenchido E score >= 0.90)
CREATE TEMP TABLE _mapping_plan ON COMMIT DROP AS
SELECT m.id AS mapping_id, m."vismedSpecialtyId",
       mp.fake_uuid, mp.correct_uuid,
       (m."invalidReason" IS NOT NULL) AS was_invalidated,
       (m."invalidReason" IS NOT NULL AND m."confidenceScore" >= 0.90) AS restore_auto_approval
FROM "SpecialtyServiceMapping" m
JOIN _merge_plan mp ON mp.fake_uuid = m."doctoraliaServiceId";

-- Snapshot COMPLETO de SpecialtyServiceMapping (validação pós campo-a-campo)
CREATE TEMP TABLE _ssm_before ON COMMIT DROP AS
SELECT * FROM "SpecialtyServiceMapping";

-- Snapshot de ProfessionalUnifiedMapping (deve permanecer intacto — runbook seção 4)
CREATE TEMP TABLE _pum_before ON COMMIT DROP AS
SELECT * FROM "ProfessionalUnifiedMapping";

-- Snapshot dos pivots compostos (JS linhas 20-23) e contagens gerais
CREATE TEMP TABLE _composite_pivots ON COMMIT DROP AS
SELECT id, "doctoraliaAddressServiceId",
       split_part("doctoraliaAddressServiceId", '_', 3) AS link_id
FROM "DoctoraliaAddressService"
WHERE "doctoraliaAddressServiceId" LIKE '%\_%' ESCAPE '\'
  AND array_length(string_to_array("doctoraliaAddressServiceId", '_'), 1) = 3;

CREATE TEMP TABLE _baseline_counts ON COMMIT DROP AS
SELECT (SELECT count(*) FROM "DoctoraliaService")           AS ds,
       (SELECT count(*) FROM "DoctoraliaAddressService")    AS das,
       (SELECT count(*) FROM "SpecialtyServiceMapping")     AS ssm,
       (SELECT count(*) FROM "ProfessionalUnifiedMapping")  AS pum;

-- ----------------------------------------------------------------------------
-- ETAPA 1 — GATE 1 REVALIDADO DENTRO DA TRANSAÇÃO (P1/P2/P3/P4/P5/P5b)
-- Runbook seção 1. Qualquer divergência → RAISE EXCEPTION → abort total.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  v_p1 int; v_p2_total int; v_p2_cobertos int; v_p2_fora int;
  v_p3_falsas int; v_p3_com_match int; v_p3_sem_match int; v_p3_com_mapping int;
  v_p4 int; v_safe int; v_nomatch int; v_ambig int; v_existing int; v_p5b int;
  v_null_norm int;
BEGIN
  -- P1: mappings contaminados pela definição OFICIAL (esperado: 34)
  SELECT count(*) INTO v_p1
  FROM "SpecialtyServiceMapping" m
  JOIN "DoctoraliaService" ds ON ds.id = m."doctoraliaServiceId"
  WHERE ds."doctoraliaServiceId" IN (SELECT sid FROM _suspect_ids);
  IF v_p1 <> 34 THEN
    RAISE EXCEPTION 'GATE1/P1 divergente: contaminados=% (esperado 34) — ABORT', v_p1;
  END IF;

  -- P2: cobertura do gatilho (esperado: 34 / 34 / 0)
  SELECT count(*),
         count(*) FILTER (WHERE ds."doctoraliaServiceId" IN (SELECT fake_id FROM _fake_ids)),
         count(*) FILTER (WHERE ds."doctoraliaServiceId" NOT IN (SELECT fake_id FROM _fake_ids))
    INTO v_p2_total, v_p2_cobertos, v_p2_fora
  FROM "SpecialtyServiceMapping" m
  JOIN "DoctoraliaService" ds ON ds.id = m."doctoraliaServiceId"
  WHERE ds."doctoraliaServiceId" IN (SELECT sid FROM _suspect_ids);
  IF v_p2_total <> 34 OR v_p2_cobertos <> 34 OR v_p2_fora <> 0 THEN
    RAISE EXCEPTION 'GATE1/P2 divergente: total=% cobertos=% fora_do_gatilho=% (esperado 34/34/0) — ABORT',
      v_p2_total, v_p2_cobertos, v_p2_fora;
  END IF;

  -- P3: entradas falsas (esperado: 126 / 126 / 0 / <registrado, NUNCA fixado>)
  SELECT count(*),
         count(*) FILTER (WHERE correct_uuid IS NOT NULL),
         count(*) FILTER (WHERE correct_uuid IS NULL)
    INTO v_p3_falsas, v_p3_com_match, v_p3_sem_match
  FROM _merge_plan;
  SELECT count(DISTINCT mp.fake_uuid) INTO v_p3_com_mapping
  FROM _merge_plan mp
  WHERE EXISTS (SELECT 1 FROM "SpecialtyServiceMapping" mm WHERE mm."doctoraliaServiceId" = mp.fake_uuid);
  IF v_p3_falsas <> 126 THEN
    RAISE EXCEPTION 'GATE1/P3 divergente: entradas_falsas=% (esperado 126) — ABORT', v_p3_falsas;
  END IF;
  IF v_p3_sem_match <> 0 THEN
    -- Divergência intencional D1: no script isto seria o ramo NO_MATCH (delete com
    -- cascade em SpecialtyServiceMapping/ProfessionalUnifiedMapping) — NÃO autorizado.
    RAISE EXCEPTION 'GATE1/P3 divergente: sem_match=% (esperado 0; ramo NO_MATCH NÃO autorizado) — ABORT', v_p3_sem_match;
  END IF;
  -- 4º valor de P3: APENAS registrado (proibido fixar em 17 — runbook seção 1)
  RAISE NOTICE 'GATE1/P3 com_mapping (4º valor, apenas registrado): %', v_p3_com_mapping;

  -- Guard D3: fallback NFD do JS não é replicável — normalizedName NULL → abort
  SELECT count(*) INTO v_null_norm FROM _fake_services WHERE "normalizedName" IS NULL;
  IF v_null_norm <> 0 THEN
    RAISE EXCEPTION 'GATE1/D3: % entrada(s) falsa(s) com normalizedName NULL (fallback NFD do JS não replicado em SQL) — ABORT', v_null_norm;
  END IF;

  -- P4: colisões com mappings preexistentes (esperado: 0)
  SELECT count(*) INTO v_p4
  FROM _mapping_plan p
  WHERE EXISTS (
    SELECT 1 FROM "SpecialtyServiceMapping" ex
    WHERE ex."vismedSpecialtyId" = p."vismedSpecialtyId"
      AND ex."doctoraliaServiceId" = p.correct_uuid
  );
  IF v_p4 <> 0 THEN
    -- Divergência intencional D2: ramo EXISTING_CORRECT_MAPPING do script — NÃO autorizado.
    RAISE EXCEPTION 'GATE1/P4 divergente: colisoes=% (esperado 0; ramo EXISTING_CORRECT_MAPPING NÃO autorizado) — ABORT', v_p4;
  END IF;

  -- Equivalência de candidatos (nota da seção 1 do runbook): o candidato escolhido
  -- com a exclusão do GATILHO do script (_fake_ids) deve ser IDÊNTICO ao escolhido
  -- com a exclusão OFICIAL (suspect_ids, forma a+b), com a mesma contagem, para
  -- TODAS as 126 entradas falsas. Divergência = o script repontaria para uma
  -- entrada que a definição oficial considera suspeita → NÃO autorizado.
  SELECT count(*) INTO v_p4
  FROM _merge_plan mp
  JOIN _merge_plan_official o ON o.fake_uuid = mp.fake_uuid
  WHERE mp.correct_uuid IS DISTINCT FROM o.correct_uuid
     OR mp.candidate_count IS DISTINCT FROM o.candidate_count;
  IF v_p4 <> 0 THEN
    RAISE EXCEPTION 'GATE1/EQUIV: % entrada(s) com candidato divergente entre exclusão do gatilho (_fake_ids) e a oficial (suspect_ids) — ABORT', v_p4;
  END IF;

  -- Alvos duplicados: dois mappings contaminados da MESMA vismedSpecialtyId
  -- convergindo ao MESMO candidato violariam o unique
  -- (vismedSpecialtyId, doctoraliaServiceId) no UPDATE em conjunto (no JS isso
  -- cairia no clash sequencial) → NÃO autorizado.
  SELECT count(*) INTO v_p4
  FROM (
    SELECT "vismedSpecialtyId", correct_uuid
    FROM _mapping_plan GROUP BY 1, 2 HAVING count(*) > 1
  ) d;
  IF v_p4 <> 0 THEN
    RAISE EXCEPTION 'GATE1/DUP: % par(es) (vismedSpecialtyId, candidato) com mais de um mapping contaminado convergindo — ABORT', v_p4;
  END IF;

  -- P5: classificação oficial (esperado: SAFE_MERGE=34, demais=0).
  -- Com o assert de equivalência acima, o candidate_count do plano do gatilho
  -- é idêntico ao da definição oficial (suspect_ids) — P5 abaixo é, portanto,
  -- exatamente a classificação oficial do runbook.
  SELECT count(*) FILTER (WHERE mp.candidate_count = 0),
         count(*) FILTER (WHERE mp.candidate_count > 1),
         count(*) FILTER (WHERE mp.candidate_count = 1 AND EXISTS (
            SELECT 1 FROM "SpecialtyServiceMapping" ex
            WHERE ex."vismedSpecialtyId" = p."vismedSpecialtyId"
              AND ex."doctoraliaServiceId" = mp.correct_uuid)),
         count(*) FILTER (WHERE mp.candidate_count = 1 AND NOT EXISTS (
            SELECT 1 FROM "SpecialtyServiceMapping" ex
            WHERE ex."vismedSpecialtyId" = p."vismedSpecialtyId"
              AND ex."doctoraliaServiceId" = mp.correct_uuid))
    INTO v_nomatch, v_ambig, v_existing, v_safe
  FROM _mapping_plan p
  JOIN _merge_plan mp ON mp.fake_uuid = p.fake_uuid;
  IF v_safe <> 34 OR v_nomatch <> 0 OR v_ambig <> 0 OR v_existing <> 0 THEN
    RAISE EXCEPTION 'GATE1/P5 divergente: SAFE_MERGE=% NO_MATCH=% AMBIGUOUS=% EXISTING=% (esperado 34/0/0/0) — ABORT',
      v_safe, v_nomatch, v_ambig, v_existing;
  END IF;

  -- P5b: MANUAL dentro do conjunto contaminado (esperado: 7)
  SELECT count(*) INTO v_p5b
  FROM "SpecialtyServiceMapping" m
  JOIN "DoctoraliaService" ds ON ds.id = m."doctoraliaServiceId"
  WHERE ds."doctoraliaServiceId" IN (SELECT sid FROM _suspect_ids)
    AND m."matchType" = 'MANUAL';
  IF v_p5b <> 7 THEN
    RAISE EXCEPTION 'GATE1/P5b divergente: MANUAL=% (esperado 7) — ABORT', v_p5b;
  END IF;

  RAISE NOTICE 'GATE 1 revalidado DENTRO da transação: P1=34, P2=34/34/0, P3=126/126/0/%, P4=0, P5=SAFE_MERGE 34, P5b=7 — OK',
    v_p3_com_mapping;
END $$;

-- ----------------------------------------------------------------------------
-- ETAPA 2 — MUTAÇÕES (SAFE_MERGE only), ordem segura para FKs
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  n_remapped int; n_pivots_repointed int; n_deleted int;
  n_dropped int; n_renamed int;
  v_check int;
BEGIN
  -- (2.1) Reapontar SpecialtyServiceMapping do fake para o correto
  --       (JS linhas 87-95, ramo SAFE_MERGE: doctoraliaServiceId, invalidReason→null,
  --       invalidAt→null, requiresReview→false só com restore_auto_approval;
  --       updatedAt = now() replica o @updatedAt automático do Prisma.
  --       Campos de decisão humana — matchType, confidenceScore, reviewedAt,
  --       reviewedBy, overrideInvalid, isActive — NÃO são tocados; runbook 0.3.)
  UPDATE "SpecialtyServiceMapping" m
  SET "doctoraliaServiceId" = p.correct_uuid,
      "invalidReason" = NULL,
      "invalidAt" = NULL,
      "requiresReview" = CASE WHEN p.restore_auto_approval THEN false ELSE m."requiresReview" END,
      "updatedAt" = now()
  FROM _mapping_plan p
  WHERE m.id = p.mapping_id;
  GET DIAGNOSTICS n_remapped = ROW_COUNT;
  IF n_remapped <> 34 THEN
    RAISE EXCEPTION 'MUT/2.1: % mapping(s) reapontado(s) (esperado 34) — ABORT', n_remapped;
  END IF;

  -- (2.2) Reapontar pivots DoctoraliaAddressService.serviceId do fake para o correto
  --       (JS linhas 101-104; updatedAt = now() replica o Prisma updateMany)
  UPDATE "DoctoraliaAddressService" das
  SET "serviceId" = p.correct_uuid,
      "updatedAt" = now()
  FROM _merge_plan p
  WHERE das."serviceId" = p.fake_uuid;
  GET DIAGNOSTICS n_pivots_repointed = ROW_COUNT;

  -- (2.3) Deletar as 126 entradas falsas do dicionário (JS linha 107).
  --       Após 2.1/2.2 nenhum mapping ou pivot referencia os fakes → o cascade
  --       das FKs não apaga nada além das próprias entradas.
  SELECT count(*) INTO v_check FROM "SpecialtyServiceMapping"
  WHERE "doctoraliaServiceId" IN (SELECT fake_uuid FROM _merge_plan);
  IF v_check <> 0 THEN
    RAISE EXCEPTION 'MUT/2.3 pré-delete: % mapping(s) ainda apontando a fakes — ABORT', v_check;
  END IF;
  SELECT count(*) INTO v_check FROM "DoctoraliaAddressService"
  WHERE "serviceId" IN (SELECT fake_uuid FROM _merge_plan);
  IF v_check <> 0 THEN
    RAISE EXCEPTION 'MUT/2.3 pré-delete: % pivot(s) ainda apontando a fakes — ABORT', v_check;
  END IF;
  DELETE FROM "DoctoraliaService" WHERE id IN (SELECT fake_uuid FROM _merge_plan);
  GET DIAGNOSTICS n_deleted = ROW_COUNT;
  IF n_deleted <> 126 THEN
    RAISE EXCEPTION 'MUT/2.3: % entrada(s) falsa(s) removida(s) (esperado 126) — ABORT', n_deleted;
  END IF;

  -- (2.4) Renomear pivots compostos addrId_docId_linkId → link id puro
  --       (JS linhas 113-143). Dedup determinística equivalente ao clash-check
  --       do JS (divergência D5): apaga o pivot composto quando (a) já existe
  --       pivot com o id puro, ou (b) outro composto com o mesmo link id foi
  --       eleito para o rename (eleição: menor createdAt, depois menor id).
  DELETE FROM "DoctoraliaAddressService" das
  USING _composite_pivots cp
  WHERE das.id = cp.id
    AND (
      EXISTS (SELECT 1 FROM "DoctoraliaAddressService" pure
              WHERE pure."doctoraliaAddressServiceId" = cp.link_id)
      OR das.id <> (
        SELECT das2.id FROM "DoctoraliaAddressService" das2
        JOIN _composite_pivots cp2 ON cp2.id = das2.id
        WHERE cp2.link_id = cp.link_id
        ORDER BY das2."createdAt" ASC, das2.id ASC LIMIT 1)
    );
  GET DIAGNOSTICS n_dropped = ROW_COUNT;

  UPDATE "DoctoraliaAddressService" das
  SET "doctoraliaAddressServiceId" = cp.link_id,
      "updatedAt" = now()
  FROM _composite_pivots cp
  WHERE das.id = cp.id;
  GET DIAGNOSTICS n_renamed = ROW_COUNT;

  -- Relatório de contadores (equivalente ao resumo do JS, linha 149).
  -- Esperado: 126 mescladas, 0 sem match, 126 removidas, 34 reapontados.
  RAISE NOTICE 'Resumo: % mesclada(s), 0 sem match, % entrada(s) falsa(s) removida(s), % mapping(s) reapontado(s), % pivot(s) reapontado(s) p/ serviço correto, % pivot(s) renomeado(s), % pivot(s) composto(s) deduplicado(s)/removido(s).',
    n_deleted, n_deleted, n_remapped, n_pivots_repointed, n_renamed, n_dropped;
END $$;

-- ----------------------------------------------------------------------------
-- ETAPA 3 — VALIDAÇÕES PÓS, DENTRO DA TRANSAÇÃO (runbook seções 9 e 9.1)
-- Falha em qualquer uma → RAISE EXCEPTION → transação inteira aborta (nada persiste).
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  v int; b record;
BEGIN
  SELECT * INTO b FROM _baseline_counts;

  -- (A) P1 pós = 0 (definição oficial, recomputando suspect_ids do estado atual)
  WITH ffc AS (
    SELECT DISTINCT split_part("doctoraliaAddressServiceId", '_', 3) AS fake_id
    FROM "DoctoraliaAddressService"
    WHERE "doctoraliaAddressServiceId" LIKE '%\_%' ESCAPE '\'
      AND array_length(string_to_array("doctoraliaAddressServiceId", '_'), 1) = 3
  ), susp AS (
    SELECT "doctoraliaAddressServiceId" AS sid FROM "DoctoraliaAddressService"
    WHERE "doctoraliaAddressServiceId" NOT LIKE '%\_%' ESCAPE '\'
    UNION SELECT fake_id FROM ffc
  )
  SELECT count(*) INTO v
  FROM "SpecialtyServiceMapping" m
  JOIN "DoctoraliaService" ds ON ds.id = m."doctoraliaServiceId"
  WHERE ds."doctoraliaServiceId" IN (SELECT sid FROM susp);
  IF v <> 0 THEN RAISE EXCEPTION 'POS/A: P1 pós=% (esperado 0) — ABORT', v; END IF;

  -- (B) Pivots compostos = 0
  SELECT count(*) INTO v FROM "DoctoraliaAddressService"
  WHERE "doctoraliaAddressServiceId" LIKE '%\_%' ESCAPE '\';
  IF v <> 0 THEN RAISE EXCEPTION 'POS/B: pivots compostos=% (esperado 0) — ABORT', v; END IF;

  -- (C) Entradas falsas eliminadas = 0
  SELECT count(*) INTO v FROM "DoctoraliaService"
  WHERE "doctoraliaServiceId" IN (SELECT fake_id FROM _fake_ids);
  IF v <> 0 THEN RAISE EXCEPTION 'POS/C: entradas falsas restantes=% (esperado 0) — ABORT', v; END IF;

  -- (D) Contagens vs baseline: DoctoraliaService −126; SpecialtyServiceMapping inalterada
  SELECT count(*) INTO v FROM "DoctoraliaService";
  IF v <> b.ds - 126 THEN
    RAISE EXCEPTION 'POS/D: DoctoraliaService=% (esperado %−126=%) — ABORT', v, b.ds, b.ds - 126;
  END IF;
  SELECT count(*) INTO v FROM "SpecialtyServiceMapping";
  IF v <> b.ssm THEN
    RAISE EXCEPTION 'POS/D: SpecialtyServiceMapping=% (esperado % — nenhum mapping deletado) — ABORT', v, b.ssm;
  END IF;

  -- (E) ProfessionalUnifiedMapping intacto: contagem + linhas byte-a-byte vs snapshot
  SELECT count(*) INTO v FROM "ProfessionalUnifiedMapping";
  IF v <> b.pum THEN RAISE EXCEPTION 'POS/E: ProfessionalUnifiedMapping=% (esperado %) — ABORT', v, b.pum; END IF;
  SELECT count(*) INTO v FROM (
    (TABLE "ProfessionalUnifiedMapping" EXCEPT TABLE _pum_before)
    UNION ALL
    (TABLE _pum_before EXCEPT TABLE "ProfessionalUnifiedMapping")
  ) d;
  IF v <> 0 THEN RAISE EXCEPTION 'POS/E: % linha(s) de ProfessionalUnifiedMapping alterada(s) — ABORT', v; END IF;

  -- (F) Mappings FORA do conjunto afetado: byte-a-byte inalterados vs snapshot
  --     (cobre a validação F do runbook — nenhum mapping preexistente/colisão tocado,
  --     incl. MANUAL fora dos 34, e nenhuma limpeza de invalidReason fora do conjunto).
  SELECT count(*) INTO v
  FROM "SpecialtyServiceMapping" cur
  JOIN _ssm_before old ON old.id = cur.id
  WHERE cur.id NOT IN (SELECT mapping_id FROM _mapping_plan)
    AND ROW(cur.*) IS DISTINCT FROM ROW(old.*);
  IF v <> 0 THEN RAISE EXCEPTION 'POS/F: % mapping(s) fora do conjunto afetado alterado(s) — ABORT', v; END IF;

  -- (G) Os 34 afetados: SOMENTE os campos autorizados mudaram
  --     (doctoraliaServiceId → correto; invalidReason/invalidAt → NULL;
  --      requiresReview=false só com restore_auto_approval; updatedAt).
  --     Campos de decisão humana idênticos — cobre os 7 MANUAL (runbook 9.1).
  SELECT count(*) INTO v
  FROM "SpecialtyServiceMapping" cur
  JOIN _ssm_before old ON old.id = cur.id
  JOIN _mapping_plan p ON p.mapping_id = cur.id
  WHERE NOT (
        cur."doctoraliaServiceId" = p.correct_uuid
    AND cur."invalidReason" IS NULL
    AND cur."invalidAt" IS NULL
    AND cur."requiresReview" = (CASE WHEN p.restore_auto_approval THEN false ELSE old."requiresReview" END)
    AND cur."vismedSpecialtyId" = old."vismedSpecialtyId"
    AND cur."matchType"        = old."matchType"
    AND cur."confidenceScore"  = old."confidenceScore"
    AND cur."reviewedAt"       IS NOT DISTINCT FROM old."reviewedAt"
    AND cur."reviewedBy"       IS NOT DISTINCT FROM old."reviewedBy"
    AND cur."overrideInvalid"  = old."overrideInvalid"
    AND cur."isActive"         = old."isActive"
    AND cur."createdAt"        = old."createdAt"
  );
  IF v <> 0 THEN RAISE EXCEPTION 'POS/G: % dos 34 mapping(s) com alteração NÃO autorizada — ABORT', v; END IF;

  -- (H) Regra de requiresReview (Observação 1 do aprovador): restauração ocorreu
  --     SOMENTE onde invalidReason estava preenchido E score >= 0.90.
  SELECT count(*) INTO v
  FROM "SpecialtyServiceMapping" cur
  JOIN _ssm_before old ON old.id = cur.id
  JOIN _mapping_plan p ON p.mapping_id = cur.id
  WHERE old."requiresReview" = true AND cur."requiresReview" = false
    AND NOT (old."invalidReason" IS NOT NULL AND old."confidenceScore" >= 0.90);
  IF v <> 0 THEN RAISE EXCEPTION 'POS/H: % restauração(ões) de requiresReview fora da regra — ABORT', v; END IF;

  -- (I) Nenhum pivot ficou sem serviço válido (integridade referencial pós-merge)
  SELECT count(*) INTO v FROM "DoctoraliaAddressService" das
  WHERE NOT EXISTS (SELECT 1 FROM "DoctoraliaService" s WHERE s.id = das."serviceId");
  IF v <> 0 THEN RAISE EXCEPTION 'POS/I: % pivot(s) órfão(s) — ABORT', v; END IF;

  RAISE NOTICE 'VALIDAÇÕES PÓS (A–I) OK dentro da transação. Contagens: DoctoraliaService %→%, SpecialtyServiceMapping % (inalterada), ProfessionalUnifiedMapping % (intacta).',
    b.ds, b.ds - 126, b.ssm, b.pum;
  RAISE NOTICE '⛔ PARADA OBRIGATÓRIA: transação ABERTA. NÃO há COMMIT neste arquivo.';
  RAISE NOTICE 'Revise as saídas acima e decida manualmente: COMMIT; (gate humano) ou ROLLBACK;';
END $$;

-- ============================================================================
-- ⛔⛔⛔ STOP — GATE HUMANO ⛔⛔⛔
--
-- A transação está ABERTA e NADA foi persistido. Este arquivo NÃO contém COMMIT.
--
-- O operador humano deve, NA MESMA SESSÃO psql, após revisar todos os RAISE
-- NOTICE acima (Gate 1 revalidado, resumo de contadores, validações pós A–I):
--
--   * Para EFETIVAR a correção (equivale ao gate `AUTORIZAÇÃO HUMANA PARA
--     EXECUTAR` do runbook, seção 13 do adendo):
--         -- COMMIT;
--
--   * Para DESCARTAR tudo (nenhuma alteração persiste):
--         -- ROLLBACK;
--
-- Se a sessão for executada de forma não-interativa (psql -f), a desconexão sem
-- COMMIT faz ROLLBACK automático — ou seja, o modo seguro é o padrão. Para
-- commitar, execute em sessão interativa (\i) e digite COMMIT; manualmente.
-- ============================================================================
