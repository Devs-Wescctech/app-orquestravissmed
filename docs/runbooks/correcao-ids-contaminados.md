# Runbook — Correção da contaminação de `DoctoraliaService.doctoraliaServiceId` por `address_service_id`

> **Ambiente-alvo: produção Portainer** (fora do Replit).
> **Escopo deste runbook:** preparação, validação e execução manual controlada. A execução real (seção 8 em diante) é intervenção manual no Portainer e **só ocorre após o gate `AUTORIZAÇÃO HUMANA PARA EXECUTAR`** (seção 12).
> Este documento é auto-contido: nenhum passo depende de contexto de chat.

## 0. Contexto e placeholders

**Problema:** um bug antigo de ingestão gravava o `address_service_id` (id do vínculo serviço↔endereço) como se fosse o `service_id` do dicionário global. Resultado auditado: **28 mappings contaminados** em `SpecialtyServiceMapping`, **126 entradas falsas** em `DoctoraliaService`, todos classificados **SAFE_MERGE** (AMBIGUOUS=0, NO_MATCH=0).

**Correção:** o script one-off `apps/api/scripts/fix-service-dict-ids.js` (auditado) reaponta mappings e pivots para a entrada correta do dicionário (match por `normalizedName`), limpa `invalidReason` causado pelo 404, apaga as entradas falsas e renomeia pivots compostos para o link id puro.

**Comportamento real do script — ramo de COLISÃO (EXISTING_CORRECT_MAPPING):** se para um mapping contaminado JÁ EXISTIR um mapping (mesma `vismedSpecialtyId`) apontando à entrada correta do dicionário, o script NÃO reaponta: ele **modifica o mapping preexistente** (limpa `invalidReason`/`invalidAt` incondicionalmente e pode setar `requiresReview=false` se esse mapping tiver score ≥ 0.90) e deleta o mapping contaminado. Esse mapping preexistente pode inclusive ser `MANUAL`. A auditoria classificou **todos os 28 casos como SAFE_MERGE (colisões = 0)** — portanto este runbook exige, no pré-check P4 (seção 1), que o número de colisões seja **0**; se for > 0, a execução é **BLOQUEADA** (o comportamento de colisão não está autorizado). Como defesa em profundidade, o baseline (seção 4.1) fotografa todos os mappings candidatos que poderiam colidir e a validação pós (seção 9) exige que estejam byte-a-byte inalterados — qualquer alteração é gate de rollback.

**IMPORTANTE — números auditados são EXPECTATIVA, não garantia.** O banco pode ter mudado desde a auditoria. Os pré-checks da seção 1 DEVEM ser re-executados imediatamente antes da execução; **qualquer divergência bloqueia tudo**.

Placeholders (ajustar aos nomes reais do stack Portainer):
- `<api>` = container da API NestJS
- `<pg>` = container Postgres
- `<db>` = nome do database
- `<user>` = usuário do Postgres

Referências de auditoria no repo: `.local/audit/plano-execucao-correcao-ids.md`, `.local/audit/audit-contaminated-mappings.sql`.

### Riscos conhecidos (por que este runbook é rígido)
1. **Estado do banco muda entre auditoria e execução** → revalidação obrigatória no dia (seção 1).
2. **Ramo NO_MATCH do script deleta com cascade**: `DoctoraliaService` → `SpecialtyServiceMapping` → `ProfessionalUnifiedMapping` (vínculos de médicos caem junto). Por isso `sem_match > 0` no pré-check ou `[SEM MATCH]` no log = **ABORT imediato**.
3. **Concorrência com sync durante a migração** → pausa em 2 camadas + verificação de `SyncRun` em andamento (seção 2).
4. **Executar contra o banco errado** → gate de DATABASE_URL mascarado + container + SHA do script (seção 5).

---

## 1. Pré-checks (read-only) — GATE 1

Rodar no psql de produção (`docker exec -it <pg> psql -U <user> -d <db>`). Prosseguir SOMENTE se os números baterem com o baseline auditado.

**Definição do conjunto contaminado (usada em TODAS as queries deste runbook):** uma entrada de `DoctoraliaService` é contaminada quando o seu `doctoraliaServiceId` é na verdade um id de VÍNCULO (address_service). Esse id de vínculo pode aparecer em `DoctoraliaAddressService.doctoraliaAddressServiceId` de **duas formas**: (a) como id puro (novo formato de ingestão) — igualdade direta; (b) como 3º componente da chave composta antiga `addrId_docId_linkId` — extraído com `split_part(..., '_', 3)`. As queries abaixo cobrem AMBAS as formas via o CTE `suspect_ids`. O **gatilho do script** (`fix-service-dict-ids.js`) enxerga apenas a forma (b) — por isso P2 distingue `cobertos_pelo_script` de `fora_do_gatilho`.

CTE padrão (prefixar em cada query que o referencia):

```sql
WITH fake_from_composite AS (
  -- forma (b): 3º componente dos pivots compostos antigos — é o que o script enxerga
  SELECT DISTINCT split_part("doctoraliaAddressServiceId", '_', 3) AS fake_id
  FROM "DoctoraliaAddressService"
  WHERE "doctoraliaAddressServiceId" LIKE '%\_%' ESCAPE '\'
    AND array_length(string_to_array("doctoraliaAddressServiceId", '_'), 1) = 3
),
suspect_ids AS (
  -- forma (a): pivots já no formato novo (link id puro)
  SELECT "doctoraliaAddressServiceId" AS sid FROM "DoctoraliaAddressService"
  WHERE "doctoraliaAddressServiceId" NOT LIKE '%\_%' ESCAPE '\'
  UNION
  -- forma (b)
  SELECT fake_id FROM fake_from_composite
)
```

```sql
-- P1: contaminação (esperado: 28)
WITH fake_from_composite AS (
  SELECT DISTINCT split_part("doctoraliaAddressServiceId", '_', 3) AS fake_id
  FROM "DoctoraliaAddressService"
  WHERE "doctoraliaAddressServiceId" LIKE '%\_%' ESCAPE '\'
    AND array_length(string_to_array("doctoraliaAddressServiceId", '_'), 1) = 3
),
suspect_ids AS (
  SELECT "doctoraliaAddressServiceId" AS sid FROM "DoctoraliaAddressService"
  WHERE "doctoraliaAddressServiceId" NOT LIKE '%\_%' ESCAPE '\'
  UNION
  SELECT fake_id FROM fake_from_composite
)
SELECT count(*) FROM "SpecialtyServiceMapping" m
JOIN "DoctoraliaService" ds ON ds.id = m."doctoraliaServiceId"
WHERE ds."doctoraliaServiceId" IN (SELECT sid FROM suspect_ids);

-- P2: cobertura do gatilho do script (esperado: 28 / 28 / 0)
WITH fake_from_composite AS (
  SELECT DISTINCT split_part("doctoraliaAddressServiceId", '_', 3) AS fake_id
  FROM "DoctoraliaAddressService"
  WHERE "doctoraliaAddressServiceId" LIKE '%\_%' ESCAPE '\'
    AND array_length(string_to_array("doctoraliaAddressServiceId", '_'), 1) = 3
),
suspect_ids AS (
  SELECT "doctoraliaAddressServiceId" AS sid FROM "DoctoraliaAddressService"
  WHERE "doctoraliaAddressServiceId" NOT LIKE '%\_%' ESCAPE '\'
  UNION
  SELECT fake_id FROM fake_from_composite
)
SELECT count(*) AS mappings_contaminados,
  count(*) FILTER (WHERE ds."doctoraliaServiceId" IN (SELECT fake_id FROM fake_from_composite)) AS cobertos_pelo_script,
  count(*) FILTER (WHERE ds."doctoraliaServiceId" NOT IN (SELECT fake_id FROM fake_from_composite)) AS fora_do_gatilho
FROM "SpecialtyServiceMapping" m
JOIN "DoctoraliaService" ds ON ds.id = m."doctoraliaServiceId"
WHERE ds."doctoraliaServiceId" IN (SELECT sid FROM suspect_ids);

-- P3: V2 (esperado: 126 / 126 / 0 / 17)
WITH fake_dict_ids AS (
  SELECT DISTINCT split_part("doctoraliaAddressServiceId", '_', 3) AS fake_id
  FROM "DoctoraliaAddressService"
  WHERE "doctoraliaAddressServiceId" LIKE '%\_%' ESCAPE '\'
    AND array_length(string_to_array("doctoraliaAddressServiceId", '_'), 1) = 3
)
SELECT count(*) AS entradas_falsas,
  count(*) FILTER (WHERE EXISTS (SELECT 1 FROM "DoctoraliaService" c
    WHERE c."normalizedName" = ds."normalizedName" AND c.id <> ds.id
      AND c."doctoraliaServiceId" NOT IN (SELECT fake_id FROM fake_dict_ids))) AS com_match,
  count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM "DoctoraliaService" c
    WHERE c."normalizedName" = ds."normalizedName" AND c.id <> ds.id
      AND c."doctoraliaServiceId" NOT IN (SELECT fake_id FROM fake_dict_ids))) AS sem_match,
  count(*) FILTER (WHERE EXISTS (SELECT 1 FROM "SpecialtyServiceMapping" mm
    WHERE mm."doctoraliaServiceId" = ds.id)) AS com_mapping
FROM "DoctoraliaService" ds
WHERE ds."doctoraliaServiceId" IN (SELECT fake_id FROM fake_dict_ids);
```

```sql
-- P4: COLISÕES com mappings preexistentes (esperado: 0)
-- Conta os casos em que já existe mapping (mesma vismedSpecialtyId) apontando ao
-- candidato correto — nesse ramo o script MODIFICA o mapping preexistente
-- (limpa invalidReason e pode setar requiresReview=false), o que NÃO está autorizado.
-- O candidato replica a escolha do script: mesmo normalizedName, id diferente,
-- excluindo apenas fake_from_composite (o conjunto que o script conhece), createdAt asc.
WITH fake_from_composite AS (
  SELECT DISTINCT split_part("doctoraliaAddressServiceId", '_', 3) AS fake_id
  FROM "DoctoraliaAddressService"
  WHERE "doctoraliaAddressServiceId" LIKE '%\_%' ESCAPE '\'
    AND array_length(string_to_array("doctoraliaAddressServiceId", '_'), 1) = 3
),
suspect_ids AS (
  SELECT "doctoraliaAddressServiceId" AS sid FROM "DoctoraliaAddressService"
  WHERE "doctoraliaAddressServiceId" NOT LIKE '%\_%' ESCAPE '\'
  UNION
  SELECT fake_id FROM fake_from_composite
)
SELECT count(*) AS colisoes
FROM "SpecialtyServiceMapping" m
JOIN "DoctoraliaService" ds ON ds.id = m."doctoraliaServiceId"
CROSS JOIN LATERAL (
  SELECT c.id FROM "DoctoraliaService" c
  WHERE c."normalizedName" = ds."normalizedName" AND c.id <> ds.id
    AND c."doctoraliaServiceId" NOT IN (SELECT fake_id FROM fake_from_composite)
  ORDER BY c."createdAt" ASC LIMIT 1
) cand
WHERE ds."doctoraliaServiceId" IN (SELECT sid FROM suspect_ids)
  AND EXISTS (
    SELECT 1 FROM "SpecialtyServiceMapping" ex
    WHERE ex."vismedSpecialtyId" = m."vismedSpecialtyId"
      AND ex."doctoraliaServiceId" = cand.id
  );
```

Valores esperados (baseline auditado — EXPECTATIVA a revalidar):
- P1 = **28**
- P2 = **28 / 28 / 0** (`fora_do_gatilho` DEVE ser 0)
- P3 = **126 / 126 / 0 / 17** (`sem_match` DEVE ser 0)
- P4 = **0 colisões** (`colisoes` DEVE ser 0 — se > 0, o script entraria no ramo EXISTING_CORRECT_MAPPING e modificaria mappings preexistentes, comportamento NÃO autorizado)
- Classificação da auditoria: **SAFE_MERGE = 28, AMBIGUOUS = 0, NO_MATCH = 0, EXISTING_CORRECT_MAPPING = 0** (queries Q3/Q4 de `.local/audit/audit-contaminated-mappings.sql` podem ser re-rodadas para confirmar).

**REGRA DE BLOQUEIO:** qualquer divergência — especialmente `sem_match > 0` (o script deletaria mappings com cascade em `ProfessionalUnifiedMapping`), `fora_do_gatilho > 0` (o script não corrigiria todos os 28) ou `colisoes > 0` (o script alteraria mappings preexistentes, possivelmente MANUAL) — → **PARAR, não executar, reportar a divergência**.

**Evidência a coletar:** saída completa de P1, P2, P3 e P4 (texto/print).

**Dry-run recomendado das queries:** antes da janela de execução, rodar as queries deste runbook (todas read-only) contra um restore do dump de auditoria (ou diretamente no banco de produção, já que não escrevem nada) e conferir que P1/P2/P3/P4 reproduzem os números auditados. Se as queries retornarem 0/vazio onde se esperam 28/126, a causa provável é divergência de formato dos pivots (puro vs composto) — investigar antes de prosseguir; não executar.

---

## 2. Writers nas 4 tabelas e o que pausar

| Processo | Escreve em | Gatilho | Precisa pausar? |
|---|---|---|---|
| Ingestão Doctoralia (`sync.service.ts` / `sync.processor.ts`) | upsert `DoctoraliaService`, `DoctoraliaAddressService` | Cron `global-sync-every-30min` (`sync-scheduler.service.ts`) e sync manual pela UI | **SIM** — principal writer |
| Matching Engine (`matching-engine.service.ts`) | create/update `SpecialtyServiceMapping` | roda dentro do ciclo de sync | **SIM** (pausa junto com o sync) |
| VisMed sync processor (`vismed-sync.processor.ts`) | update/delete `SpecialtyServiceMapping` | ciclo de sync VisMed | **SIM** (pausa junto) |
| Push de serviços (`push-sync.service.ts` → `markMappingInvalid`) | update `SpecialtyServiceMapping.invalidReason` | ciclo de push (dentro do sync) | **SIM** (pausa junto) |
| Block-watcher (`block-watcher.service.ts`, cron 10min) | não escreve nas 4 tabelas, mas dispara fluxo de sync | respeita `status='paused'` | coberto pela pausa da fila |
| Token refresher (cron 15min) | só tokens de integração | — | **NÃO** |
| Booking polling/sweep (`booking-sync.service.ts`) | apenas **leitura** nas 4 tabelas | polling | NÃO obrigatório (a pausa da fila também o cobre) |
| Operador na UI `/mapping` (`mappings.service.ts`) | update `SpecialtyServiceMapping`, `ProfessionalUnifiedMapping` | ação humana | **SIM — não usar a UI de mapping durante a janela** |

### 2.1 Como pausar (2 camadas — usar AMBAS)

1. **Pausa da fila por clínica** (mecanismo oficial, respeitado por scheduler, block-watcher e syncs manuais):
   - `POST /sync/:clinicId/queue/toggle` com body `{"enabled": false}` (a Central de Sincronização na UI faz o mesmo). Seta `IntegrationConnection.status='paused'` para doctoralia+vismed.
   - Confirmar: status da clínica mostra `queueEnabled=false`; ou SQL:
     ```sql
     SELECT provider, status FROM "IntegrationConnection" WHERE provider IN ('doctoralia','vismed');
     ```
     → todos `paused`.
2. **Kill-switch do cron** (cinto e suspensório): definir `DISABLE_SYNC_CRON=true` no ambiente do container `<api>` e reiniciar o container. Confirmar no log:
   `[SCHEDULER] Sync cron DESATIVADO via DISABLE_SYNC_CRON=true.`
3. **Confirmar quiescência** — aguardar o fim de qualquer `SyncRun` em andamento:
   ```sql
   SELECT id, status, "startedAt" FROM "SyncRun"
   WHERE status IN ('running','in_progress')
   ORDER BY "startedAt" DESC LIMIT 5;
   ```
   Deve retornar **0 linhas** antes de prosseguir.

### 2.2 Como reativar depois (referência — pós-gate)
- Remover `DISABLE_SYNC_CRON` (ou `=false`) + restart do `<api>`;
- `POST /sync/:clinicId/queue/toggle` `{"enabled": true}` para cada clínica pausada;
- Confirmar no log a próxima execução do cron de 30min e status `connected` nas conexões.

---

## 3. Backup / rollback

Executar no host do Portainer, **após** a pausa e quiescência:

```bash
TS=$(date +%Y%m%d_%H%M%S)
docker exec <pg> pg_dump -U <user> -d <db> --format=custom \
  -t '"DoctoraliaService"' -t '"DoctoraliaAddressService"' \
  -t '"SpecialtyServiceMapping"' -t '"ProfessionalUnifiedMapping"' \
  -f /tmp/fix_dict_backup_${TS}.dump
docker cp <pg>:/tmp/fix_dict_backup_${TS}.dump ./backups/

# Validação do backup:
docker exec <pg> pg_restore --list /tmp/fix_dict_backup_${TS}.dump | head -30   # deve listar as 4 tabelas
ls -lh ./backups/fix_dict_backup_${TS}.dump                                     # tamanho > 0
sha256sum ./backups/fix_dict_backup_${TS}.dump                                  # checksum de evidência
```

**Evidência OBRIGATÓRIA do backup (Observação 2 do aprovador):** registrar, para o dump usado NAQUELA execução:
- identificação do arquivo (nome completo `fix_dict_backup_<TS>.dump`);
- timestamp (`TS` e `date -Iseconds` no momento do dump);
- tamanho em bytes (`ls -l`);
- hash/checksum (`sha256sum` do arquivo).

Sem esses 4 itens registrados, o checklist de backup **não** pode ser marcado.

### 3.1 Restore seletivo (rollback) — SÓ se a validação pós falhar

```bash
# Restaura as 4 tabelas (drop+recreate) a partir do dump:
docker exec -i <pg> pg_restore -U <user> -d <db> --clean --if-exists \
  -t '"DoctoraliaService"' -t '"DoctoraliaAddressService"' \
  -t '"SpecialtyServiceMapping"' -t '"ProfessionalUnifiedMapping"' \
  /tmp/fix_dict_backup_${TS}.dump
```
> `--clean` derruba e recria as tabelas com FKs; **manter a aplicação pausada durante o restore**. Após rollback, re-rodar P1 (deve voltar a 28) e reativar writers (seção 2.2).

---

## 4. Baseline (evidência ANTES da execução)

```sql
-- Contagens gerais (guardar):
SELECT 'DoctoraliaService' t, count(*) FROM "DoctoraliaService"
UNION ALL SELECT 'DoctoraliaAddressService', count(*) FROM "DoctoraliaAddressService"
UNION ALL SELECT 'SpecialtyServiceMapping', count(*) FROM "SpecialtyServiceMapping"
UNION ALL SELECT 'ProfessionalUnifiedMapping', count(*) FROM "ProfessionalUnifiedMapping";
-- + P1 (28) e pivots compostos (126) da seção 1.
```

```sql
-- Relação dos 28 (exportar em CSV: \copy (...) TO 'baseline_28.csv' CSV HEADER)
WITH fake_from_composite AS (
  SELECT DISTINCT split_part("doctoraliaAddressServiceId", '_', 3) AS fake_id
  FROM "DoctoraliaAddressService"
  WHERE "doctoraliaAddressServiceId" LIKE '%\_%' ESCAPE '\'
    AND array_length(string_to_array("doctoraliaAddressServiceId", '_'), 1) = 3
),
suspect_ids AS (
  SELECT "doctoraliaAddressServiceId" AS sid FROM "DoctoraliaAddressService"
  WHERE "doctoraliaAddressServiceId" NOT LIKE '%\_%' ESCAPE '\'
  UNION
  SELECT fake_id FROM fake_from_composite
)
SELECT vs.name AS vismed_specialty, m.id AS mapping_id,
       ds.id AS fake_uuid, ds."doctoraliaServiceId" AS fake_ext_id, ds.name AS fake_name,
       cand.id AS correct_uuid, cand."doctoraliaServiceId" AS correct_ext_id, cand.name AS correct_name,
       m."matchType", m."confidenceScore", m."requiresReview", m."invalidReason", m."isActive"
FROM "SpecialtyServiceMapping" m
JOIN "DoctoraliaService" ds ON ds.id = m."doctoraliaServiceId"
LEFT JOIN "VismedSpecialty" vs ON vs.id = m."vismedSpecialtyId"
LEFT JOIN LATERAL (
  SELECT c.* FROM "DoctoraliaService" c
  WHERE c."normalizedName" = ds."normalizedName" AND c.id <> ds.id
    AND c."doctoraliaServiceId" NOT IN (SELECT fake_id FROM fake_from_composite)
  ORDER BY c."createdAt" ASC LIMIT 1
) cand ON true
WHERE ds."doctoraliaServiceId" IN (SELECT sid FROM suspect_ids)
ORDER BY vs.name;
```

```sql
-- Snapshot de ProfessionalUnifiedMapping ligado aos 28 (deve permanecer intacto):
WITH fake_from_composite AS (
  SELECT DISTINCT split_part("doctoraliaAddressServiceId", '_', 3) AS fake_id
  FROM "DoctoraliaAddressService"
  WHERE "doctoraliaAddressServiceId" LIKE '%\_%' ESCAPE '\'
    AND array_length(string_to_array("doctoraliaAddressServiceId", '_'), 1) = 3
),
suspect_ids AS (
  SELECT "doctoraliaAddressServiceId" AS sid FROM "DoctoraliaAddressService"
  WHERE "doctoraliaAddressServiceId" NOT LIKE '%\_%' ESCAPE '\'
  UNION
  SELECT fake_id FROM fake_from_composite
)
SELECT pum.id, pum."vismedDoctorId", pum."doctoraliaDoctorId", pum."specialtyServiceMappingId"
FROM "ProfessionalUnifiedMapping" pum
WHERE pum."specialtyServiceMappingId" IN (
  SELECT m.id FROM "SpecialtyServiceMapping" m
  JOIN "DoctoraliaService" ds ON ds.id = m."doctoraliaServiceId"
  WHERE ds."doctoraliaServiceId" IN (SELECT sid FROM suspect_ids));
```

### 4.1 Snapshot dos mappings candidatos que poderiam colidir (`baseline_colisao.csv`)

Fotografa TODO mapping já apontando a um candidato correto dos 28 — o conjunto que o ramo de colisão do script poderia alterar. Com P4 = 0 espera-se **0 linhas de colisão real**, mas o snapshot cobre também os mappings dos serviços candidatos em geral, como defesa em profundidade:

```sql
-- Exportar: \copy (...) TO 'baseline_colisao.csv' CSV HEADER
WITH fake_from_composite AS (
  SELECT DISTINCT split_part("doctoraliaAddressServiceId", '_', 3) AS fake_id
  FROM "DoctoraliaAddressService"
  WHERE "doctoraliaAddressServiceId" LIKE '%\_%' ESCAPE '\'
    AND array_length(string_to_array("doctoraliaAddressServiceId", '_'), 1) = 3
),
suspect_ids AS (
  SELECT "doctoraliaAddressServiceId" AS sid FROM "DoctoraliaAddressService"
  WHERE "doctoraliaAddressServiceId" NOT LIKE '%\_%' ESCAPE '\'
  UNION
  SELECT fake_id FROM fake_from_composite
),
candidatos AS (
  SELECT DISTINCT cand.id AS candidate_uuid
  FROM "SpecialtyServiceMapping" m
  JOIN "DoctoraliaService" ds ON ds.id = m."doctoraliaServiceId"
  CROSS JOIN LATERAL (
    SELECT c.id FROM "DoctoraliaService" c
    WHERE c."normalizedName" = ds."normalizedName" AND c.id <> ds.id
      AND c."doctoraliaServiceId" NOT IN (SELECT fake_id FROM fake_from_composite)
    ORDER BY c."createdAt" ASC LIMIT 1
  ) cand
  WHERE ds."doctoraliaServiceId" IN (SELECT sid FROM suspect_ids)
)
SELECT ex.id AS mapping_id, ex."vismedSpecialtyId", vs.name AS vismed_specialty,
       ex."doctoraliaServiceId" AS service_uuid, ds2."doctoraliaServiceId" AS dict_ext_id,
       ex."matchType", ex."confidenceScore", ex."requiresReview",
       ex."invalidReason", ex."invalidAt", ex."overrideInvalid", ex."isActive",
       ex."updatedAt"
FROM "SpecialtyServiceMapping" ex
JOIN candidatos c ON c.candidate_uuid = ex."doctoraliaServiceId"
JOIN "DoctoraliaService" ds2 ON ds2.id = ex."doctoraliaServiceId"
LEFT JOIN "VismedSpecialty" vs ON vs.id = ex."vismedSpecialtyId"
ORDER BY vs.name;
```

**Evidências a coletar:** contagens gerais, `baseline_28.csv`, `baseline_colisao.csv`, snapshot PUM.

---

## 5. Verificação do script/ambiente — GATE 2 (proteção contra banco/script errado)

### 5.1 SHA-256 de referência do script auditado

```
a98f588f78762e9e1d5a0bd372676af1aa70ab57004dccbbb955bb14af4e771c  apps/api/scripts/fix-service-dict-ids.js
```

### 5.2 Conferências obrigatórias no container

```bash
# 1) SHA do script DENTRO do container deve ser IDÊNTICO ao de referência acima:
docker exec <api> sha256sum apps/api/scripts/fix-service-dict-ids.js

# 2) Commit/branch/imagem em execução (registrar como evidência):
docker exec <api> git log -1 --format='%H %s' 2>/dev/null || echo "verificar tag da imagem no Portainer"

# 3) Banco efetivo que o Prisma usará (NÃO imprimir senha — mascarado):
docker exec <api> sh -c 'echo $DATABASE_URL | sed -E "s#//[^@]+@#//***@#"'
```

**Regras de ABORT (qualquer uma que falhe → ABORTAR, não executar):**
- SHA do script no container ≠ `a98f588f78762e9e1d5a0bd372676af1aa70ab57004dccbbb955bb14af4e771c`;
- host do `DATABASE_URL` NÃO é o Postgres do stack do Portainer (se aparecer host do Replit/Neon ou qualquer outro → **ABORTAR**);
- container/branch/tag de deployment não correspondem ao stack de produção esperado.

**Evidências a coletar:** saída dos 3 comandos (SHA, commit/tag, DATABASE_URL mascarado).

---

## 6. Critérios de ABORT (consolidado)

- Pré-checks P1/P2/P3/P4 divergentes do baseline — em especial `sem_match > 0`, `fora_do_gatilho > 0` ou `colisoes > 0` (seção 1);
- Qualquer `SyncRun` em `running`/`in_progress` no momento da execução (seção 2.1.3);
- Backup não gerado, não validado por `pg_restore --list`, ou sem as 4 evidências (arquivo/timestamp/tamanho/checksum) — seção 3;
- Falha em QUALQUER conferência do GATE 2 (SHA, DATABASE_URL, container/branch) — seção 5;
- Durante a execução: qualquer linha `[SEM MATCH]` no log (esperado: nenhuma);
- Resumo final do script diferente de `126 mesclado(s), 0 sem match, 126 entrada(s) falsa(s) removida(s), 28 mapping(s) reapontado(s)` (contadores de pivots renomeados/deduplicados podem variar até 126);
- Erro Prisma / constraint violation / processo interrompido → considerar estado parcial → rodar validações (seção 9); se inconsistente, rollback (seção 3.1).

---

## 7. Evidências obrigatórias (resumo)

**Antes:** resultados de P1/P2/P3/P4; `baseline_28.csv`; `baseline_colisao.csv`; contagens gerais das 4 tabelas; snapshot de `ProfessionalUnifiedMapping`; identificação + timestamp + tamanho + sha256 do dump de backup; saídas do GATE 2 (SHA do script, commit/tag, DATABASE_URL mascarado).

**Depois:** log completo do script (`fix_dict_run_<TS>.log`); resultados das validações pós (seção 9); consultas de Mastologia (seção 10).

---

═══════════════════════════════════════════════════════════════════
**⛔ TUDO A PARTIR DAQUI SÓ PODE SER EXECUTADO APÓS O GATE `[ ] AUTORIZAÇÃO HUMANA PARA EXECUTAR` DO CHECKLIST (seção 12). As seções 8–11 constam como REFERÊNCIA para o operador.**
═══════════════════════════════════════════════════════════════════

## 8. Execução (referência — SOMENTE após autorização humana explícita)

```bash
docker exec <api> node apps/api/scripts/fix-service-dict-ids.js 2>&1 | tee fix_dict_run_${TS}.log
```

Monitorar em tempo real; aplicar os critérios de ABORT da seção 6.

---

## 9. Validação pós-execução (referência — pós-gate)

```sql
-- A) Contaminação zerada (esperado: 0) → re-rodar P1 da seção 1
-- B) Pivots compostos zerados (esperado: 0):
SELECT count(*) FROM "DoctoraliaAddressService" WHERE "doctoraliaAddressServiceId" LIKE '%\_%' ESCAPE '\';
-- C) Entradas falsas eliminadas: re-rodar P3; entradas_falsas deve ser 0.
-- D) Contagens vs baseline:
--    DoctoraliaService = baseline − 126;
--    SpecialtyServiceMapping = baseline (28 reapontados, NENHUM deletado — todos SAFE_MERGE);
--    ProfessionalUnifiedMapping = baseline (0 perdas). Conferir os IDs do snapshot da seção 4.
-- E) invalidReason limpo SÓ nos afetados / requiresReview:
SELECT m.id, vs.name, m."confidenceScore", m."matchType", m."requiresReview", m."invalidReason"
FROM "SpecialtyServiceMapping" m
LEFT JOIN "VismedSpecialty" vs ON vs.id = m."vismedSpecialtyId"
WHERE m.id IN (/* mapping_ids do baseline_28.csv */);
-- F) Mappings preexistentes (potenciais colisões) INALTERADOS — comparar com baseline_colisao.csv:
--    Re-rodar a query da seção 4.1 e comparar campo a campo (matchType, confidenceScore,
--    requiresReview, invalidReason, invalidAt, overrideInvalid, isActive, updatedAt) com o CSV.
--    QUALQUER diferença em qualquer linha = alteração NÃO autorizada → GATE DE ROLLBACK
--    (seção 3.1). Com P4 = 0 no pré-check, nenhuma alteração é esperada.
```

**Restrição OBRIGATÓRIA sobre `requiresReview` (Observação 1 do aprovador):**
Qualquer restauração de `requiresReview=false` deve seguir **estritamente a lógica já existente do script**: apenas mappings **diretamente afetados pelo bug** (ou seja, que tinham `invalidReason` preenchido por causa da invalidação provocada pelo id falso) **e** com `confidenceScore >= 0.90`. É **PROIBIDO** reclassificar (restaurar auto-aprovação de) mappings não relacionados ao bug apenas por terem score ≥ 0.90. Validar contra o `baseline_28.csv`: só os mappings desse conjunto que tinham `invalidReason` e score ≥ 0.90 podem ter passado a `requiresReview=false`.

Regras adicionais:
- Nenhum mapping `MANUAL` pode ter sido alterado além do reaponte de ID; decisões MANUAL permanecem intocadas. **Atenção ao ramo de colisão do script** (seção 0): ele alteraria mappings preexistentes (inclusive MANUAL) limpando `invalidReason` incondicionalmente — por isso P4 = 0 é pré-condição de execução e a validação F acima é gate de rollback;
- `invalidReason` de mappings FORA do conjunto afetado deve permanecer como estava (rejeições legítimas continuam inválidas até remapeamento em `/mapping`).

Se qualquer validação falhar → rollback (seção 3.1) + re-rodar P1 (deve voltar a 28).

---

## 10. Checklist específico de Mastologia (referência — pós-gate)

**Estado ANTES (evidência):** o mapping de Mastologia aponta para o fake `3893319`, com `invalidReason` preenchido.

```sql
-- DEPOIS: registrar o dict id REAL que o banco retornar (NÃO assumir 4152):
SELECT vs.name, ds."doctoraliaServiceId" AS dict_id_corrigido, ds.name AS servico,
       m."matchType", m."confidenceScore", m."requiresReview", m."invalidReason"
FROM "SpecialtyServiceMapping" m
JOIN "VismedSpecialty" vs ON vs.id = m."vismedSpecialtyId"
JOIN "DoctoraliaService" ds ON ds.id = m."doctoraliaServiceId"
WHERE vs.name ILIKE '%mastolog%';

-- Confirmar que 3893319 saiu do dicionário (esperado: 0):
SELECT count(*) FROM "DoctoraliaService" WHERE "doctoraliaServiceId" = '3893319';
```

**Fase catálogo (validação independente):** após reativação dos writers, acompanhar 1 ciclo de push. Se Mastologia falhar novamente com `fora do catálogo da unidade ...` (evento `invalid_service_id` do gate de catálogo), o problema passou a ser **disponibilidade na facility** → **NÃO reverter** a correção de ID, **NÃO usar override**; registrar a ocorrência para remapeamento funcional em `/mapping`.

---

## 11. Reativação e observação (referência — pós-gate)

1. Reativar conforme seção 2.2 (env + toggle da fila);
2. Acompanhar 1 ciclo completo de sync/push nos logs (`SERVICE_PUSH`), sem novos `invalid_service_id` por link-id;
3. Re-rodar P1 após o ciclo (esperado: continua 0 — confirma que a ingestão atual não recontamina);
4. Verificar Mastologia na UI (sai de "SERVIÇO INVÁLIDO NA DOCTORALIA").

---

## 12. Checklist de execução

```text
[ ] Pré-validação P1+P2 = 28/28/0 (fora_do_gatilho = 0)
[ ] Pré-validação P3 = 126/126/0/17 (sem_match = 0)
[ ] Pré-validação P4 = 0 colisões (senão o script alteraria mappings preexistentes — BLOQUEAR)
[ ] Classificação confirmada: SAFE_MERGE=28, AMBIGUOUS=0, NO_MATCH=0, EXISTING_CORRECT_MAPPING=0
[ ] Writers identificados e plano de pausa entendido (seção 2)
[ ] Sync/push pausados (toggle da fila + DISABLE_SYNC_CRON) e quiescência confirmada (0 SyncRun em running)
[ ] Backup concluído e validado (pg_restore --list + tamanho > 0)
[ ] Evidência do backup registrada: arquivo + timestamp + tamanho + sha256 do dump
[ ] Baseline salvo (contagens + baseline_28.csv + baseline_colisao.csv + snapshot ProfessionalUnifiedMapping)
[ ] GATE 2 conferido: sha256 do script no container = a98f588f78762e9e1d5a0bd372676af1aa70ab57004dccbbb955bb14af4e771c
[ ] GATE 2 conferido: DATABASE_URL mascarado aponta para o Postgres do stack Portainer (senão ABORT)
[ ] GATE 2 conferido: container/commit/branch/tag corretos (senão ABORT)
[ ] Critérios de ABORT lidos e entendidos (seção 6)
[ ] Validações pós-execução e restrições do aprovador lidas (seção 9, incl. regra de requiresReview)
[ ] Checklist de Mastologia lido (seção 10)
[ ] AUTORIZAÇÃO HUMANA PARA EXECUTAR   ← ⛔ STOP — PARADA OBRIGATÓRIA ⛔
```

**⛔ STOP.** Nada além desta linha é executado no âmbito da preparação. A execução real do script e todos os passos das seções 8–11 são **intervenção manual no Portainer**, realizada por um operador humano **somente após** a autorização acima. Itens pós-gate (para o operador, como referência):

```text
[ ] Script executado com log salvo (fix_dict_run_<TS>.log)
[ ] unmatched = 0 no log (nenhuma linha [SEM MATCH])
[ ] Resumo do script = 126 mesclado(s) / 0 sem match / 126 removida(s) / 28 reapontado(s)
[ ] Contaminação pós = 0 (P1) e pivots compostos = 0
[ ] DoctoraliaService = baseline − 126; SpecialtyServiceMapping = baseline
[ ] ProfessionalUnifiedMapping preservado (contagem + IDs do snapshot)
[ ] invalidReason limpo SÓ nos afetados; requiresReview restaurado SÓ conforme Observação 1; MANUAL intocados
[ ] Validação F: mappings preexistentes idênticos ao baseline_colisao.csv (qualquer diff → rollback)
[ ] Mastologia corrigida (dict id real registrado; 3893319 ausente do dicionário)
[ ] Writers reativados (seção 2.2)
[ ] Ciclo de sync/push validado (sem novos link-ids; P1 continua 0; fase catálogo de Mastologia observada)
```
