-- P1a: SyncJob — deduplicação atômica via índice único parcial.
--
-- IMPORTANTE: esta migration NÃO toma nenhuma decisão de negócio sobre
-- duplicatas existentes. Ela apenas: (a) copia a chave de dedup do campo
-- legado ("lockedBy" em jobs PENDING/FAILED) para a nova coluna "dedupKey";
-- (b) DETECTA colisões que violariam o índice e ABORTA com relatório
-- (rollback total — nenhum job é alterado); (c) cria o índice único parcial.

-- 1) Nova coluna
ALTER TABLE "SyncJob" ADD COLUMN IF NOT EXISTS "dedupKey" TEXT;

CREATE INDEX IF NOT EXISTS "SyncJob_dedupKey_idx" ON "SyncJob"("dedupKey");

-- 2) Copiar lockedBy -> dedupKey APENAS em PENDING/FAILED (nesses status o
--    lockedBy legado ainda contém a chave de dedup; em RUNNING ele foi
--    sobrescrito pelo WORKER_ID e em COMPLETED/DEAD é irrelevante — ficam NULL
--    e jobs sem chave nunca deduplicam).
UPDATE "SyncJob"
SET "dedupKey" = "lockedBy"
WHERE status IN ('PENDING', 'FAILED')
  AND "lockedBy" IS NOT NULL
  AND "dedupKey" IS NULL;

-- 3) Detectar duplicatas ativas e abortar (fail-safe, resolução humana fora
--    da migration). Se limpo, registra evidência via RAISE NOTICE.
DO $$
DECLARE
    dup RECORD;
    report TEXT := '';
    n INT := 0;
BEGIN
    FOR dup IN
        SELECT "dedupKey",
               json_agg(json_build_object(
                   'id', id,
                   'status', status,
                   'attempts', attempts,
                   'maxAttempts', "maxAttempts",
                   'createdAt', "createdAt",
                   'nextRunAt', "nextRunAt"
               ) ORDER BY "createdAt") AS jobs
        FROM "SyncJob"
        WHERE "dedupKey" IS NOT NULL
          AND (status IN ('PENDING', 'RUNNING')
               OR (status = 'FAILED' AND attempts < "maxAttempts"))
        GROUP BY "dedupKey"
        HAVING count(*) >= 2
    LOOP
        n := n + 1;
        report := report || format(E'\n  dedupKey=%s -> %s', dup."dedupKey", dup.jobs::text);
    END LOOP;

    IF n > 0 THEN
        RAISE EXCEPTION E'SyncJob dedup migration ABORTADA: % colisao(oes) de dedupKey ativa(s) exigem resolucao humana antes de criar o indice unico. NENHUM job foi alterado (rollback).%', n, report;
    ELSE
        RAISE NOTICE 'SyncJob dedup migration: nenhuma duplicata ativa de dedupKey encontrada; seguro criar o indice unico parcial.';
    END IF;
END $$;

-- 4) Índice único parcial: no máximo UM job "ativo" por dedupKey.
--    Ativo = PENDING, RUNNING ou FAILED ainda com retries restantes.
--    COMPLETED e DEAD liberam a chave para novos eventos legítimos.
CREATE UNIQUE INDEX IF NOT EXISTS "SyncJob_dedupKey_active_key"
ON "SyncJob"("dedupKey")
WHERE "dedupKey" IS NOT NULL
  AND (status IN ('PENDING', 'RUNNING')
       OR (status = 'FAILED' AND attempts < "maxAttempts"));
