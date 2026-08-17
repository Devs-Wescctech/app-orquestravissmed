# Runbook — Correção da contaminação de `DoctoraliaService.doctoraliaServiceId` por `address_service_id`

> **Ambiente-alvo: produção Portainer** (fora do Replit).
> **Escopo deste runbook:** preparação, validação e execução manual controlada. A execução real (seção 8 em diante) é intervenção manual no Portainer e **só ocorre após o gate `AUTORIZAÇÃO HUMANA PARA EXECUTAR`** (seção 12).
> Este documento é auto-contido: nenhum passo depende de contexto de chat.

## 0. Contexto e placeholders

**Problema:** um bug antigo de ingestão gravava o `address_service_id` (id do vínculo serviço↔endereço) como se fosse o `service_id` do dicionário global. Resultado auditado (auditoria read-only no banco real do Portainer, 2026-08-14+): **34 mappings contaminados** em `SpecialtyServiceMapping`, **126 entradas falsas** em `DoctoraliaService`, todos classificados **SAFE_MERGE** (AMBIGUOUS=0, NO_MATCH=0, EXISTING_CORRECT_MAPPING=0). O baseline anterior de 28 estava incompleto por definição de detecção — ver seção 0.1 ("Por que o baseline mudou de 28 para 34").

**Correção:** o script one-off `apps/api/scripts/fix-service-dict-ids.js` (auditado) reaponta mappings e pivots para a entrada correta do dicionário (match por `normalizedName`), limpa `invalidReason` causado pelo 404, apaga as entradas falsas e renomeia pivots compostos para o link id puro.

**Comportamento real do script — ramo de COLISÃO (EXISTING_CORRECT_MAPPING):** se para um mapping contaminado JÁ EXISTIR um mapping (mesma `vismedSpecialtyId`) apontando à entrada correta do dicionário, o script NÃO reaponta: ele **modifica o mapping preexistente** (limpa `invalidReason`/`invalidAt` incondicionalmente e pode setar `requiresReview=false` se esse mapping tiver score ≥ 0.90) e deleta o mapping contaminado. Esse mapping preexistente pode inclusive ser `MANUAL`. A auditoria classificou **todos os 34 casos como SAFE_MERGE (colisões = 0)** — portanto este runbook exige, no pré-check P4 (seção 1), que o número de colisões seja **0**; se for > 0, a execução é **BLOQUEADA** (o comportamento de colisão não está autorizado). Como defesa em profundidade, o baseline (seção 4.1) fotografa todos os mappings candidatos que poderiam colidir e a validação pós (seção 9) exige que estejam byte-a-byte inalterados — qualquer alteração aciona a REGRA OBRIGATÓRIA da seção 3.2 (congelar estado, preservar evidências, aguardar autorização humana para restore).

**IMPORTANTE — números auditados são EXPECTATIVA, não garantia.** O banco pode ter mudado desde a auditoria. Os pré-checks da seção 1 DEVEM ser re-executados imediatamente antes da execução (Gate 1 re-executado imediatamente antes de qualquer autorização); **qualquer divergência bloqueia tudo**.

### 0.1 Por que o baseline mudou de 28 para 34

A auditoria read-only concluída no banco REAL do Portainer (2026-08-14+) mostrou que o total estruturalmente contaminado é **34**, e não 28. Fatos consolidados:

- **Não houve 6 mappings novos** e **não há evidência de recontaminação ativa**: nenhuma entrada falsa ou pivot composto foi criado após 2026-08-14 nem nos 7 dias anteriores à auditoria.
- **Os 34 são históricos** — todos já existiam antes de 2026-08-14.
- A diferença 28→34 veio de **DEFINIÇÃO da detecção**: a query antiga era mais restrita (não derivava o link id dos pivots compostos em todas as formas). A definição **oficial** do Gate 1 é a do CTE `suspect_ids` com as **duas formas** de pivot (id puro + composto via `split_part`), já presente na seção 1.
- **NÃO usar `invalidReason` isoladamente como definição de contaminação.** Distribuição observada nos 34: **24 ERRO_ADDRESS_SERVICE, 6 ERRO_CATALOGO_FACILITY, 4 SEM_ERRO_ATUAL** — todos os 34 são estruturalmente derivados dos IDs falsos históricos e classificados **SAFE_MERGE**.

### 0.2 Veredito de recontaminação

**Não há evidência de recontaminação ativa do dicionário pela ingestão atual.** Sobre `apps/api/fetch_catalog.js` e `apps/api/import_catalog_and_map.js`: têm o padrão histórico perigoso de `item.id`, mas estão **excluídos da imagem por `.dockerignore`**, fora do runtime do Dockerfile e não são invocados por package.json/entrypoint/compose/NestJS — classificação: **código presente, não executável em produção e não utilizado**. NÃO tratá-los como writer ativo na tabela da seção 2. A remoção deles é follow-up separado que **NÃO bloqueia** esta correção.

### 0.3 Regra dos mappings MANUAL (baseline: 7 dos 34)

**Mappings MANUAL preservam integralmente a decisão humana.** `matchType`, `confidenceScore`, `reviewedAt`, `reviewedBy`, `overrideInvalid` e `isActive` **não podem ser alterados**. No ramo SAFE_MERGE, o script pode reapontar `doctoraliaServiceId`, limpar `invalidReason`/`invalidAt` causados pela contaminação e restaurar `requiresReview=false` quando a invalidação técnica colocou o mapping novamente em revisão e `confidenceScore >= 0.90`.

MANUAL esperado no baseline = **7**: Ginecologia e obstetrícia (1), Mastologia (2), Medicina de Família e Comunidade (2), Oftalmologia (2). Nos 7 (auditado): `confidenceScore=1`, `requiresReview=true`, `invalidReason` do bug de address_service_id, `overrideInvalid=false` — o script setaria `requiresReview=false`.

Comportamento confirmado do script no ramo SAFE_MERGE (`apps/api/scripts/fix-service-dict-ids.js:87-95`): altera somente `doctoraliaServiceId`, `invalidReason→null`, `invalidAt→null`, `requiresReview→false` (só se `invalidReason` preenchido E score ≥ 0.90) e `updatedAt` automático. **NÃO altera** `matchType`, `confidenceScore`, `reviewedAt`, `reviewedBy`, `overrideInvalid`, `isActive`, `id`, `vismedSpecialtyId`.

É **PROIBIDO** preencher `reviewedAt`/`reviewedBy` vazios (são evidência histórica; fora de escopo).

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
-- P1: contaminação (esperado: 34)
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

-- P2: cobertura do gatilho do script (esperado: 34 / 34 / 0)
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

-- P3: V2 (esperado: 126 / 126 / 0 / <COM_MAPPING_ATUAL_VALIDADO>)
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

```sql
-- P5: CLASSIFICAÇÃO com a definição OFICIAL (esperado: SAFE_MERGE=34, demais=0)
-- Replica a classificação da auditoria usando o CTE suspect_ids (duas formas de pivot).
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
contaminated AS (
  SELECT m.id AS mapping_id, m."vismedSpecialtyId", ds.id AS fake_uuid,
         COALESCE(ds."normalizedName", lower(trim(ds.name))) AS norm
  FROM "SpecialtyServiceMapping" m
  JOIN "DoctoraliaService" ds ON ds.id = m."doctoraliaServiceId"
  WHERE ds."doctoraliaServiceId" IN (SELECT sid FROM suspect_ids)
),
cands AS (
  SELECT cm.mapping_id, cm."vismedSpecialtyId",
         count(cand.id) AS candidate_count,
         (ARRAY_AGG(cand.id ORDER BY cand."createdAt" ASC))[1] AS chosen_uuid
  FROM contaminated cm
  LEFT JOIN "DoctoraliaService" cand
    ON cand."normalizedName" = cm.norm
   AND cand.id <> cm.fake_uuid
   AND cand."doctoraliaServiceId" NOT IN (SELECT sid FROM suspect_ids)
  GROUP BY cm.mapping_id, cm."vismedSpecialtyId"
)
SELECT CASE
  WHEN candidate_count = 0 THEN 'NO_MATCH'
  WHEN candidate_count > 1 THEN 'AMBIGUOUS'
  WHEN EXISTS (SELECT 1 FROM "SpecialtyServiceMapping" ex
               WHERE ex."vismedSpecialtyId" = c."vismedSpecialtyId"
                 AND ex."doctoraliaServiceId" = c.chosen_uuid)
       THEN 'EXISTING_CORRECT_MAPPING'
  ELSE 'SAFE_MERGE'
END AS class, count(*)
FROM cands c
GROUP BY 1 ORDER BY 1;

-- P5b: MANUAL dentro do conjunto contaminado (esperado: 7)
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
SELECT count(*) AS manual_contaminados
FROM "SpecialtyServiceMapping" m
JOIN "DoctoraliaService" ds ON ds.id = m."doctoraliaServiceId"
WHERE ds."doctoraliaServiceId" IN (SELECT sid FROM suspect_ids)
  AND m."matchType" = 'MANUAL';
```

> Nota sobre P5: a exclusão de candidatos usa `suspect_ids` (definição oficial de detecção). O script exclui apenas `fake_from_composite` na escolha do candidato — com P2 `fora_do_gatilho = 0` os dois conjuntos coincidem para os casos cobertos; qualquer divergência entre P5 e a expectativa é bloqueio de qualquer forma.

Valores esperados (baseline auditado — EXPECTATIVA a revalidar no dia):
- P1 = **34**
- P2 = **34 / 34 / 0** (`fora_do_gatilho` DEVE ser 0)
- P3 = **126 / 126 / 0 / `<COM_MAPPING_ATUAL_VALIDADO>`** (`sem_match` DEVE ser 0). O 4º valor (`com_mapping`) é **placeholder a derivar do SQL atual no dia** e tratado como expectativa a revalidar — NÃO reutilizar o antigo "17".
- P4 = **0 colisões** (`colisoes` DEVE ser 0 — se > 0, o script entraria no ramo EXISTING_CORRECT_MAPPING e modificaria mappings preexistentes, comportamento NÃO autorizado)
- P5 (classificação, abaixo) = **SAFE_MERGE = 34, AMBIGUOUS = 0, NO_MATCH = 0, EXISTING_CORRECT_MAPPING = 0**; P5b (MANUAL) = **7**.
  **ATENÇÃO:** as queries Q3/Q4 de `.local/audit/audit-contaminated-mappings.sql` usam a definição ANTIGA de detecção (igualdade direta pivot=id, sem `split_part` dos compostos) — foi exatamente essa definição que deixou 6 casos de fora. Elas NÃO validam o baseline 34; usar P5/P5b deste runbook.
- MANUAL esperado dentro dos 34 = **7** (ver seção 0.3).

**Definição oficial do conjunto contaminado (Gate 1):** a das **duas formas de pivot** (puro + composto via `split_part`) do CTE `suspect_ids` acima — é essa definição que produz 34.

**REGRA DE BLOQUEIO:** qualquer divergência — especialmente `sem_match > 0` (o script deletaria mappings com cascade em `ProfessionalUnifiedMapping`), `fora_do_gatilho > 0` (o script não corrigiria todos os 34) ou `colisoes > 0` (o script alteraria mappings preexistentes, possivelmente MANUAL) — → **PARAR, não executar, reportar a divergência**.

**Evidência a coletar:** saída completa de P1, P2, P3 e P4 (texto/print).

**Dry-run recomendado das queries:** antes da janela de execução, rodar as queries deste runbook (todas read-only) contra um restore do dump de auditoria (ou diretamente no banco de produção, já que não escrevem nada) e conferir que P1/P2/P3/P4 reproduzem os números auditados. Se as queries retornarem 0/vazio onde se esperam 34/126, a causa provável é divergência de formato dos pivots (puro vs composto) — investigar antes de prosseguir; não executar.

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

> **Nota:** `apps/api/fetch_catalog.js` e `apps/api/import_catalog_and_map.js` NÃO constam desta tabela por decisão auditada — são código presente mas **não executável em produção e não utilizado** (excluídos por `.dockerignore`, fora do runtime; ver seção 0.2). Não tratá-los como writer ativo.

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

### 3.1 Restore seletivo — SEGUNDA INTERVENÇÃO, com gate humano próprio

**O restore NUNCA é automático.** Ele é uma NOVA intervenção em produção, distinta da execução do script, e **só pode ocorrer após aprovação explícita do segundo gate: `[ ] AUTORIZAÇÃO HUMANA PARA RESTORE`** (ver seção 3.2). Em caso de divergência pós-execução, o procedimento é congelar o estado e aguardar decisão humana — NÃO executar os comandos abaixo por iniciativa própria.

```bash
# (SOMENTE após o gate AUTORIZAÇÃO HUMANA PARA RESTORE)
# Restaura as 4 tabelas (drop+recreate) a partir do dump:
docker exec -i <pg> pg_restore -U <user> -d <db> --clean --if-exists \
  -t '"DoctoraliaService"' -t '"DoctoraliaAddressService"' \
  -t '"SpecialtyServiceMapping"' -t '"ProfessionalUnifiedMapping"' \
  /tmp/fix_dict_backup_${TS}.dump
```
> `--clean` derruba e recria as tabelas com FKs; **manter a aplicação pausada durante o restore**. Após o restore autorizado, re-rodar P1 (deve voltar a 34) e reativar writers (seção 2.2).

### 3.2 REGRA OBRIGATÓRIA — Rollback/restore NUNCA é automático

Em QUALQUER divergência pós-execução — incluindo: `[SEM MATCH]` no log; erro Prisma; constraint violation; interrupção parcial; resumo do script diferente do esperado; P1 pós ≠ 0; pivots compostos ≠ 0; perda de `SpecialtyServiceMapping`; perda/alteração inesperada em `ProfessionalUnifiedMapping`; alteração indevida de mapping MANUAL (incl. validação F vs `baseline_colisao.csv`); qualquer divergência vs baseline — o procedimento é:

1. **NÃO reativar writers**; manter sync/push pausados;
2. **NÃO executar `pg_restore`**; **NÃO tentar corrigir manualmente**;
3. **Preservar o banco no estado encontrado**;
4. **Preservar** log completo do script, baseline, dumps e hashes;
5. Executar **somente SELECTs diagnósticos** (read-only);
6. **Registrar** a divergência encontrada;
7. **PARAR** e apresentar o diagnóstico para decisão humana.

Esta regra **substitui** toda orientação anterior do tipo "se inconsistente, rollback". O restore (seção 3.1) é uma segunda intervenção em produção e só pode ocorrer após aprovação explícita do gate `[ ] AUTORIZAÇÃO HUMANA PARA RESTORE`.

---

## 4. Baseline (evidência ANTES da execução)

```sql
-- Contagens gerais (guardar):
SELECT 'DoctoraliaService' t, count(*) FROM "DoctoraliaService"
UNION ALL SELECT 'DoctoraliaAddressService', count(*) FROM "DoctoraliaAddressService"
UNION ALL SELECT 'SpecialtyServiceMapping', count(*) FROM "SpecialtyServiceMapping"
UNION ALL SELECT 'ProfessionalUnifiedMapping', count(*) FROM "ProfessionalUnifiedMapping";
-- + P1 (34) e pivots compostos (126) da seção 1.
```

```sql
-- Relação dos 34 (exportar em CSV: \copy (...) TO 'baseline_34.csv' CSV HEADER)
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
SELECT vs.name AS vismed_specialty, m.id AS mapping_id, m."vismedSpecialtyId",
       ds.id AS fake_uuid, ds."doctoraliaServiceId" AS fake_ext_id, ds.name AS fake_name,
       cand.id AS correct_uuid, cand."doctoraliaServiceId" AS correct_ext_id, cand.name AS correct_name,
       m."matchType", m."confidenceScore", m."requiresReview",
       m."invalidReason", m."invalidAt",
       m."reviewedAt", m."reviewedBy", m."overrideInvalid", m."isActive"
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
-- Snapshot de ProfessionalUnifiedMapping ligado aos 34 (deve permanecer intacto):
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

Fotografa TODO mapping já apontando a um candidato correto dos 34 — o conjunto que o ramo de colisão do script poderia alterar. Com P4 = 0 espera-se **0 linhas de colisão real**, mas o snapshot cobre também os mappings dos serviços candidatos em geral, como defesa em profundidade:

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

**Evidências a coletar:** contagens gerais, `baseline_34.csv`, `baseline_colisao.csv`, snapshot PUM.

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
- Resumo final do script diferente de `126 mesclado(s), 0 sem match, 126 entrada(s) falsa(s) removida(s), 34 mapping(s) reapontado(s)` (contadores de pivots renomeados/deduplicados podem variar até 126);
- Erro Prisma / constraint violation / processo interrompido → considerar estado parcial → rodar validações read-only (seção 9); se inconsistente, aplicar a REGRA OBRIGATÓRIA da seção 3.2: **congelar estado, preservar evidências e aguardar autorização humana para restore** (NÃO executar restore automaticamente).

---

## 7. Evidências obrigatórias (resumo)

**Antes:** resultados de P1/P2/P3/P4; `baseline_34.csv`; `baseline_colisao.csv`; contagens gerais das 4 tabelas; snapshot de `ProfessionalUnifiedMapping`; identificação + timestamp + tamanho + sha256 do dump de backup; saídas do GATE 2 (SHA do script, commit/tag, DATABASE_URL mascarado).

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
--    SpecialtyServiceMapping = baseline (34 reapontados, NENHUM deletado — todos SAFE_MERGE);
--    ProfessionalUnifiedMapping = baseline (0 perdas). Conferir os IDs do snapshot da seção 4.
-- E) invalidReason limpo SÓ nos afetados / requiresReview:
SELECT m.id, vs.name, m."confidenceScore", m."matchType", m."requiresReview", m."invalidReason"
FROM "SpecialtyServiceMapping" m
LEFT JOIN "VismedSpecialty" vs ON vs.id = m."vismedSpecialtyId"
WHERE m.id IN (/* mapping_ids do baseline_34.csv */);
-- F) Mappings preexistentes (potenciais colisões) INALTERADOS — comparar com baseline_colisao.csv:
--    Re-rodar a query da seção 4.1 e comparar campo a campo (matchType, confidenceScore,
--    requiresReview, invalidReason, invalidAt, overrideInvalid, isActive, updatedAt) com o CSV.
--    QUALQUER diferença em qualquer linha = alteração NÃO autorizada → aplicar a REGRA
--    OBRIGATÓRIA da seção 3.2: congelar estado, preservar evidências e aguardar
--    autorização humana para restore. Com P4 = 0 no pré-check, nenhuma alteração é esperada.
```

**Restrição OBRIGATÓRIA sobre `requiresReview` (Observação 1 do aprovador):**
Qualquer restauração de `requiresReview=false` deve seguir **estritamente a lógica já existente do script**: apenas mappings **diretamente afetados pelo bug** (ou seja, que tinham `invalidReason` preenchido por causa da invalidação provocada pelo id falso) **e** com `confidenceScore >= 0.90`. É **PROIBIDO** reclassificar (restaurar auto-aprovação de) mappings não relacionados ao bug apenas por terem score ≥ 0.90. Validar contra o `baseline_34.csv`: só os mappings desse conjunto que tinham `invalidReason` e score ≥ 0.90 podem ter passado a `requiresReview=false`.

Regras adicionais:
- **Regra dos MANUAL (ver seção 0.3):** mappings MANUAL preservam integralmente a decisão humana. `matchType`, `confidenceScore`, `reviewedAt`, `reviewedBy`, `overrideInvalid` e `isActive` não podem ser alterados. No ramo SAFE_MERGE, o script pode reapontar `doctoraliaServiceId`, limpar `invalidReason`/`invalidAt` causados pela contaminação e restaurar `requiresReview=false` quando a invalidação técnica colocou o mapping novamente em revisão e `confidenceScore >= 0.90`. **Atenção ao ramo de colisão do script** (seção 0): ele alteraria mappings preexistentes (inclusive MANUAL) limpando `invalidReason` incondicionalmente — por isso P4 = 0 é pré-condição de execução e qualquer falha na validação F acima aciona a REGRA OBRIGATÓRIA da seção 3.2 (congelar, preservar, parar — restore só com o gate `AUTORIZAÇÃO HUMANA PARA RESTORE`);
- `invalidReason` de mappings FORA do conjunto afetado deve permanecer como estava (rejeições legítimas continuam inválidas até remapeamento em `/mapping`).

### 9.1 Validação pós dedicada dos 7 mappings MANUAL (ANTES→DEPOIS)

MANUAL esperado no baseline = **7**: Ginecologia e obstetrícia (1), Mastologia (2), Medicina de Família e Comunidade (2), Oftalmologia (2). O `baseline_34.csv` (seção 4) exporta todos os campos comparados aqui (`vismedSpecialtyId`, `matchType`, `confidenceScore`, `requiresReview`, `invalidReason`, `invalidAt`, `reviewedAt`, `reviewedBy`, `overrideInvalid`, `isActive`) — a comparação ANTES→DEPOIS é feita campo a campo contra esse snapshot. Para cada um dos 7 (linhas do `baseline_34.csv` com `matchType=MANUAL`):

- **Idênticos (obrigatório):** `id`, `vismedSpecialtyId`, `matchType=MANUAL`, `confidenceScore`, `reviewedAt`, `reviewedBy`, `overrideInvalid`, `isActive`;
- **Mudança esperada:** `doctoraliaServiceId` mudou do id falso para o correto;
- **Permitido:** `invalidReason`/`invalidAt` limpos quando causados pelo bug; `requiresReview` pode ir `true→false` SOMENTE nas condições auditadas (`invalidReason` preenchido pelo bug E `confidenceScore >= 0.90` — nos 7 auditados, score = 1);
- **PROIBIDO:** preencher `reviewedAt`/`reviewedBy` vazios (são evidência histórica; fora de escopo).

**Qualquer alteração fora dessas regras = divergência** → writers permanecem pausados + gate `AUTORIZAÇÃO HUMANA PARA RESTORE` (seção 3.2).

Se qualquer validação falhar → aplicar a REGRA OBRIGATÓRIA da seção 3.2: **NÃO executar restore**; congelar estado, manter writers pausados, preservar evidências, rodar apenas SELECTs diagnósticos, registrar a divergência e PARAR no gate `[ ] AUTORIZAÇÃO HUMANA PARA RESTORE`. Somente após esse gate humano o restore da seção 3.1 pode ser executado (e então re-rodar P1, que deve voltar a 34).

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
[ ] Pré-validação P1 = 34; P2 = 34/34/0 (fora_do_gatilho = 0)
[ ] Pré-validação P3 = 126/126/0/<COM_MAPPING_ATUAL_VALIDADO> (sem_match = 0; 4º valor derivado do SQL no dia)
[ ] Pré-validação P4 = 0 colisões (senão o script alteraria mappings preexistentes — BLOQUEAR)
[ ] Classificação confirmada via P5 (definição oficial): SAFE_MERGE=34, AMBIGUOUS=0, NO_MATCH=0, EXISTING_CORRECT_MAPPING=0
[ ] MANUAL no baseline = 7 via P5b (Gineco 1, Masto 2, MFC 2, Oftalmo 2 — seção 0.3)
[ ] Regra: QUALQUER divergência nos valores acima → STOP, não executar
[ ] Writers identificados e plano de pausa entendido (seção 2)
[ ] Sync/push pausados (toggle da fila + DISABLE_SYNC_CRON) e quiescência confirmada (0 SyncRun em running)
[ ] Backup concluído e validado (pg_restore --list + tamanho > 0)
[ ] Evidência do backup registrada: arquivo + timestamp + tamanho + sha256 do dump
[ ] Baseline salvo (contagens + baseline_34.csv + baseline_colisao.csv + snapshot ProfessionalUnifiedMapping)
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
[ ] Resumo do script = 126 mesclado(s) / 0 sem match / 126 removida(s) / 34 reapontado(s)
[ ] Contaminação pós = 0 (P1) e pivots compostos = 0
[ ] DoctoraliaService = baseline − 126; SpecialtyServiceMapping = baseline
[ ] ProfessionalUnifiedMapping preservado (contagem + IDs do snapshot)
[ ] invalidReason limpo SÓ nos afetados; requiresReview restaurado SÓ conforme Observação 1
[ ] Validação dedicada dos 7 MANUAL passou (seção 9.1: campos de decisão humana idênticos; só reaponte/limpeza autorizada)
[ ] Validação F: mappings preexistentes idênticos ao baseline_colisao.csv (qualquer diff → seção 3.2)
[ ] Mastologia corrigida (dict id real registrado; 3893319 ausente do dicionário)
[ ] Writers reativados (seção 2.2)
[ ] Ciclo de sync/push validado (sem novos link-ids; P1 continua 0; fase catálogo de Mastologia observada)
```

**Ramo de DIVERGÊNCIA (qualquer validação pós falhou — seguir seção 3.2):**

```text
[ ] Writers permanecem pausados (NÃO reativar)
[ ] Estado do banco preservado (nenhum restore, nenhuma correção manual)
[ ] Logs/evidências preservados (log do script, baseline, dumps, hashes)
[ ] Diagnóstico read-only concluído (somente SELECTs) e divergência registrada
[ ] AUTORIZAÇÃO HUMANA PARA RESTORE   ← ⛔ STOP — segundo gate humano; restore (seção 3.1) só depois dele ⛔
```

---

## 13. ADENDO — Via SQL direta (container `<api>` parado)

**Quando usar:** o operador tem acesso direto ao PostgreSQL de produção (psql no `<pg>`), mas o container `<api>` está **parado e não será religado**. Nesse cenário `node apps/api/scripts/fix-service-dict-ids.js` (seção 8) é inviável; a correção é executada pelo artefato SQL transacional versionado:

```
docs/runbooks/sql/fix-service-dict-ids-transacional.sql
```

Esse artefato é a tradução auditada do script JS (SHA-256 do JS: `a98f588f78762e9e1d5a0bd372676af1aa70ab57004dccbbb955bb14af4e771c`). Ele revalida TODO o Gate 1 (P1/P2/P3/P4/P5/P5b) **dentro da própria transação** via `RAISE EXCEPTION`, executa somente o ramo SAFE_MERGE, roda as validações pós (seção 9, incl. 9.1 dos 7 MANUAL) ainda dentro da transação e **termina SEM COMMIT** — o `COMMIT` manual do operador é o gate humano.

### 13.1 Divergências INTENCIONAIS vs o script JS auditado

| # | Script JS | Via SQL |
|---|---|---|
| D1 | Ramo NO_MATCH: deleta a entrada falsa com **cascade** em mappings/PUM | `RAISE EXCEPTION` (abort da transação inteira) |
| D2 | Ramo EXISTING_CORRECT_MAPPING/colisão: **modifica mapping preexistente** (limpa invalidReason, pode setar requiresReview=false) e deleta o contaminado | `RAISE EXCEPTION` (abort) |
| D3 | Fallback de `normalizedName` por normalização NFD em JS | Não replicado (sem `unaccent` garantido); `normalizedName` NULL em entrada falsa → `RAISE EXCEPTION` |
| D4 | Candidato ordenado só por `createdAt` asc | Desempate extra por `id` asc (determinismo total; sem efeito com P5 AMBIGUOUS=0) |
| D5 | Clash-check iterativo dos pivots compostos (rename ou delete por iteração) | Dedup determinística em conjunto: mantém 1 pivot por link id puro (eleição por `createdAt` asc, `id` asc); resultado final equivalente |
| D6 | Script commita implicitamente a cada operação | **Sem COMMIT no arquivo** — transação fica aberta aguardando decisão humana |

**Propriedades de segurança adicionais da via SQL (não são divergências de semântica de mutação):** todos os gates pré (P1/P2/P3/P4/P5/P5b) e as validações pós rodam **dentro** da transação — qualquer falha desfaz tudo automaticamente; assert extra de **equivalência de candidatos** entre a exclusão do gatilho do script (`fake_from_composite`) e a definição oficial (`suspect_ids`) para as 126 entradas; assert extra de **alvos duplicados** (dois mappings da mesma `vismedSpecialtyId` convergindo ao mesmo candidato → abort, em vez do clash sequencial do JS).

Consequência da D6 + gates transacionais: o restore da seção 3.1 **não é necessário nesta via** enquanto não houver COMMIT — abort/ROLLBACK não persiste nada. O backup da seção 3 continua **obrigatório** mesmo assim (defesa em profundidade para o pós-COMMIT).

### 13.2 GATE 2 redefinido para a via SQL

O Gate 2 original (seção 5) verifica script/ambiente **no container** — inaplicável com o `<api>` parado. Substituir por:

1. **Hash do artefato SQL** — o arquivo usado na execução deve ter SHA-256 idêntico ao de referência:
   ```
   50975a7a5fc8ceedd12796e6bb1b94797aa56ddf9579d4d8ab6c963aff0864f2  docs/runbooks/sql/fix-service-dict-ids-transacional.sql
   ```
   Conferir no host que executa: `sha256sum fix-service-dict-ids-transacional.sql`. Divergência = arquivo alterado → **ABORT** (regenerar/reauditar o hash via commit no repo antes).
2. **Prova de banco-alvo por SQL** (registrar a saída como evidência):
   ```sql
   SELECT current_database() AS db,
          inet_server_addr() AS server_ip,
          inet_server_port() AS server_port,
          current_user,
          version();
   -- Contagens-sentinela (devem bater com o baseline auditado de produção):
   SELECT 'DoctoraliaService' t, count(*) FROM "DoctoraliaService"
   UNION ALL SELECT 'DoctoraliaAddressService', count(*) FROM "DoctoraliaAddressService"
   UNION ALL SELECT 'SpecialtyServiceMapping', count(*) FROM "SpecialtyServiceMapping"
   UNION ALL SELECT 'ProfessionalUnifiedMapping', count(*) FROM "ProfessionalUnifiedMapping";
   -- P1 deve retornar 34 (seção 1). Se retornar 0/valor de outro ambiente → banco errado → ABORT.
   ```
   `db`/`server_ip` devem corresponder ao Postgres do stack Portainer (NUNCA host Replit/Neon).
3. **Quiescência com container parado**:
   ```bash
   docker ps --filter name=<api>        # deve NÃO listar o container (parado)
   ```
   ```sql
   -- Nenhuma conexão de aplicação no banco (só a sessão do psql do operador):
   SELECT pid, usename, application_name, client_addr, state
   FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid();
   -- Nenhum SyncRun em andamento:
   SELECT id, status, "startedAt" FROM "SyncRun"
   WHERE status IN ('running','in_progress') ORDER BY "startedAt" DESC LIMIT 5;  -- 0 linhas
   ```
   Com o `<api>` parado, a pausa de 2 camadas da seção 2.1 fica automaticamente satisfeita (não há writers); ainda assim NÃO usar a UI `/mapping` (não há UI ativa com o container parado) e registrar a evidência acima.

### 13.3 Checklist adaptado (até a autorização humana)

```text
[ ] Backup das 4 tabelas concluído e validado + 4 evidências (seção 3)
[ ] Baseline salvo (contagens + baseline_34.csv + baseline_colisao.csv + snapshot PUM — seção 4)
[ ] GATE 2 (SQL): sha256 do artefato = 50975a7a5fc8ceedd12796e6bb1b94797aa56ddf9579d4d8ab6c963aff0864f2
[ ] GATE 2 (SQL): prova de banco-alvo registrada (current_database/inet_server_addr/sentinelas/P1=34)
[ ] GATE 2 (SQL): container <api> confirmado parado + pg_stat_activity sem conexões de app + 0 SyncRun ativo
[ ] Divergências intencionais D1–D6 (seção 13.1) lidas e entendidas
[ ] Execução em sessão psql INTERATIVA: \i fix-service-dict-ids-transacional.sql (com \o/tee para log)
[ ] Todos os RAISE NOTICE revisados: Gate 1 revalidado OK; Resumo = 126 mescladas / 0 sem match /
    126 removidas / 34 reapontados; validações pós A–I OK
[ ] Em QUALQUER RAISE EXCEPTION: transação já abortada — executar ROLLBACK;, preservar o log,
    registrar a divergência e PARAR (seção 3.2 se aplicável; nada foi persistido)
[ ] AUTORIZAÇÃO HUMANA PARA EXECUTAR (= digitar COMMIT;)   ← ⛔ STOP — o COMMIT é o gate humano ⛔
```

Pós-COMMIT: seguir os itens pós-gate da seção 12 que se aplicam (Mastologia — seção 10; NÃO reativar writers via seção 2.2 enquanto o container permanecer parado; ao religar o stack no futuro, executar a observação da seção 11).
