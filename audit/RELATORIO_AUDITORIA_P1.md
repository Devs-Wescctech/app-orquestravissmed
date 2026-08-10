# Relatório — Auditoria read-only da migration P1 do SyncJob (prod Portainer)

Data: 10/08/2026 · 100% read-only · Nenhuma ação corretiva executada.

## Fontes de evidência (separadas)

**1. Banco de produção (Portainer):** NÃO consultado. O banco roda no host do
Portainer e é inacessível a partir deste workspace; `PROD_DATABASE_URL` /
`executeSql(production)` apontam para o deployment de TESTE do Replit e foram
descartados como evidência. O script read-only pronto está em
`audit/p1_syncjob_audit_readonly.sql`; a saída do psql não foi fornecida.

**2. Runtime real (logs do container, 10/08/2026 15:09–15:10):**
`attached_assets/Pasted--Nest-172-...-1786374611772.txt`
- Confirma que é o ambiente REAL: médicos reais (Dra. Adriana Gonçalves,
  Dra. Thayná Lacerda, Dr. José Roberto Mendonça…), facility Doctoralia 91711,
  "processed 2725 VisMed appointments", VisMed `app.vissmed.com.br` — não são
  as clínicas de teste "VisMed Central Clinic"/"VisMed Unidade Sul".
- API rodando normalmente (processo 172, ciclos de sync ativos) — consistente
  com um boot que NÃO abortou; porém o trecho de log NÃO inclui o boot
  (nenhuma linha `[entrypoint]`), e não dá para confirmar por log que a imagem
  em execução contém o entrypoint novo com a migration P1.

**3. Código/repositório:** migration
`apps/api/prisma/migrations/20260809_syncjob_dedup_lease/migration.sql`
(coluna `dedupKey`, índice `SyncJob_dedupKey_idx`, UNIQUE parcial
`SyncJob_dedupKey_active_key` com o predicado exato, backfill lockedBy→dedupKey,
abort em duplicata) e `docker-entrypoint.sh` que a aplica no boot (`set -e`,
container encerra se falhar). Testes de dedup/lease existem
(`queue.service.dedup-lease.spec.ts`). **Nada disso prova aplicação no banco.**

## Tabela A–I

| Item | Verificação | Status | Observação |
|---|---|---|---|
| A | Coluna `SyncJob.dedupKey` (tipo/nullability) | 🔴 não verificável | Sem acesso ao banco; requer bloco [2] do script |
| B | Índice `SyncJob_dedupKey_idx` | 🔴 não verificável | Requer bloco [3] |
| C | UNIQUE parcial `SyncJob_dedupKey_active_key` | 🔴 não verificável | Requer bloco [3b] |
| D | Predicado WHERE exato do UNIQUE parcial | 🔴 não verificável | Requer bloco [3b]; UNIQUE global não conta |
| E | Duplicidades ativas por dedupKey | 🔴 não verificável | Requer bloco [4] |
| F | Contagem de jobs por status | 🔴 não verificável | Requer bloco [5] |
| G | Ownership/lease dos RUNNING | 🔴 não verificável | Requer bloco [5b] |
| H | Backfill lockedBy → dedupKey | 🔴 não verificável | Requer bloco [6] |
| I | Runtime/deploy | 🟡 parcialmente verificável | Logs confirmam prod real rodando hoje sem crash; mas sem linhas de boot `[entrypoint] Aplicando migration P1...` e sem `_prisma_migrations` |

## Veredito

**❌ P1 NÃO CONFIRMADA EM PRODUÇÃO** — não há nenhuma evidência direta do banco
de produção. A migration existe no repositório e o entrypoint a aplica no boot,
mas, conforme a regra da auditoria, isso não pode ser usado para inferir que
ela foi executada no Postgres real do Portainer.

## Como confirmar (1 passo, ~1 min)

No console do container `vismed` (ou no host):

```bash
psql "$DATABASE_URL" -f audit/p1_syncjob_audit_readonly.sql
```

Com a saída (blocos [1]–[7]) é possível reclassificar A–H e emitir
✅ P1 CONFIRMADA. Alternativamente, `docker logs vismed | grep entrypoint`
confirma o item I (linha "Aplicando migration P1 do SyncJob").
