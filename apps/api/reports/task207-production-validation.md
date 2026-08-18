# Task 207 — Validação em produção (Portainer) do escopo de categorias por empresa

Data: 2026-08-18

## Resultado

**A migration `20260817_specialty_empresa_scope` ainda NÃO foi aplicada no banco do Portainer.**

O deploy do código da task 206 (e da migration) precisa ser feito antes de qualquer confirmação de estabilização.

---

## Estado atual do banco de produção (Portainer)

### Migrations aplicadas

| Migration | Status |
|---|---|
| `0_init` | ✅ Aplicada (2026-04-07) |
| `20260817_specialty_empresa_scope` | ❌ **Não aplicada** |

### Schema de `VismedSpecialty`

Colunas presentes:

```
id, vismedId, name, createdAt, updatedAt, normalizedName
```

`idEmpresaGestora` **ausente** — confirma que a migration não rodou.

### Índices em `VismedSpecialty`

| Índice | Tipo |
|---|---|
| `VismedSpecialty_pkey` | PK em `id` |
| `VismedSpecialty_vismedId_key` | UNIQUE GLOBAL em `vismedId` (pré-task-206) |

O unique global ainda está ativo → homônimas (192 empresa 4 / 3484 empresa 52) **não podem coexistir** enquanto a migration não for aplicada.

### Especialidades no banco

- Total: **71 registros**, zero duplicatas em `vismedId` (único global ativo).
- Fonoaudiologia presente: `vismedId=24157` (único). IDs 192 e 3484 **não estão no banco** — um dos dois foi sobrescrito pelo ping-pongue antes do sistema parar de sincronizar.

### Atividade de sync recente

| Clínica | Último sync | Status |
|---|---|---|
| `8504b5c6` | 2026-07-24 18:30 UTC | `full`: failed, `vismed-full`: completed |
| `9dc4e07c` | 2026-07-24 18:30 UTC | `full`: completed, `vismed-full`: completed |

**Último sync: 2026-07-24** (~25 dias atrás). O container parece não estar rodando ou polling não está ativo.

### SyncEvent — ações relacionadas a especialidades

Não há nenhum evento com action `specialty_migrated` ou `specialty_claimed` — esses eventos só existem no código da task 206, que ainda não foi deployado.

---

## Ação necessária: Deploy para o Portainer

### Passos

1. **Build e push da imagem** com o código da task 206 (branch/commit pós-merge).
2. **Aplicar a migration** no banco do Portainer (via `npx prisma migrate deploy` dentro do container, ou rodando o SQL diretamente):

```sql
-- 1. Nova coluna de escopo
ALTER TABLE "VismedSpecialty" ADD COLUMN "idEmpresaGestora" INTEGER;

-- 2. Troca do unique global pelo composto
DROP INDEX IF EXISTS "VismedSpecialty_vismedId_key";
CREATE UNIQUE INDEX "VismedSpecialty_idEmpresaGestora_vismedId_key"
    ON "VismedSpecialty"("idEmpresaGestora", "vismedId");

-- 3. Índice parcial para registros legados sem escopo
CREATE UNIQUE INDEX "VismedSpecialty_vismedId_unscoped_key"
    ON "VismedSpecialty"("vismedId") WHERE "idEmpresaGestora" IS NULL;

CREATE INDEX "VismedSpecialty_normalizedName_idx" ON "VismedSpecialty"("normalizedName");

-- 4. Backfill fail-closed
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
```

3. **Reiniciar o container** com a nova imagem.

---

## Queries de validação pós-deploy

Execute estas queries **após o primeiro ciclo de sync completo** de cada clínica (~30 min):

### 1. Migration aplicada?

```sql
SELECT column_name FROM information_schema.columns
WHERE table_name = 'VismedSpecialty' AND column_name = 'idEmpresaGestora';
-- Deve retornar 1 linha
```

### 2. Homônimas coexistindo (192 empresa 4 + 3484 empresa 52)?

```sql
SELECT "vismedId", "idEmpresaGestora", name
FROM "VismedSpecialty"
WHERE lower(name) LIKE '%fono%'
ORDER BY "vismedId";
-- Deve mostrar DOIS registros de Fonoaudiologia com vismedId diferentes
```

### 3. Zero vínculos cruzados entre empresas?

```sql
SELECT count(*) AS cross_links
FROM "VismedSpecialty" s
JOIN "VismedProfessionalSpecialty" vps ON vps."vismedSpecialtyId" = s.id
JOIN "Mapping" m ON m."vismedId" = vps."vismedDoctorId" AND m."entityType" = 'DOCTOR'
JOIN "IntegrationConnection" ic
    ON ic."clinicId" = m."clinicId"
   AND ic.provider = 'vismed'
   AND ic."clientId" ~ '^[0-9]+$'
WHERE s."idEmpresaGestora" IS NOT NULL
  AND s."idEmpresaGestora" != (ic."clientId")::int;
-- Deve retornar 0
```

### 4. Eventos de claim (primeiro ciclo) e zero migrated após estabilização?

A task 206 usa SyncEvent com `entityType=SPECIALTY` e `action=specialty_claimed` / `action=specialty_migrated`.

```sql
SELECT "entityType", action, count(*) AS cnt,
       min(timestamp AT TIME ZONE 'utc') AS first_seen,
       max(timestamp AT TIME ZONE 'utc') AS last_seen
FROM "SyncEvent"
WHERE action IN ('specialty_claimed', 'specialty_migrated')
GROUP BY "entityType", action
ORDER BY action;
-- specialty_claimed: deve aparecer nos primeiros ciclos (reivindicação dos legados)
-- specialty_migrated: deve ser ZERO após 2-3 ciclos completos
```

### 5. Novos agendamentos Petrópolis com categoria da faixa 3xxx?

```sql
SELECT b."externalId", b."createdAt" AT TIME ZONE 'utc',
       b."vismedCategoryId", vs.name
FROM "BookingSync" b
JOIN "VismedSpecialty" vs ON vs."vismedId" = b."vismedCategoryId"
WHERE b."createdAt" > now() AT TIME ZONE 'utc' - interval '3 hours'
ORDER BY b."createdAt" DESC
LIMIT 10;
-- vismedCategoryId dos agendamentos da clínica Petrópolis deve estar na faixa 3xxx
```

---

## Critérios de confirmação (pós-deploy)

| Critério | Esperado |
|---|---|
| Migration aplicada | ✅ `idEmpresaGestora` existe |
| Homônimas coexistindo | ✅ Fonoaudiologia 192 (emp 4) + 3484 (emp 52) simultâneas |
| Vínculos cruzados | ✅ 0 |
| `specialty_claimed` no primeiro ciclo | ✅ ≥1 evento por empresa |
| `specialty_migrated` após 2-3 ciclos | ✅ 0 novos eventos |
| Agendamentos Petrópolis | ✅ categoria na faixa 3xxx |
