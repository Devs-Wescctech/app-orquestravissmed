#!/usr/bin/env bash
# Inicializacao do container unico VisMed (API NestJS + Web Next.js).
# - Aplica o schema no Postgres do HOST (idempotente, sem --accept-data-loss).
# - Roda o seed (idempotente: usa upsert/findFirst).
# - Sobe API e Web no mesmo container; encerra o container se qualquer um cair.
set -euo pipefail

SCHEMA="/app/apps/api/prisma/schema.prisma"

if [ -z "${DATABASE_URL:-}" ]; then
  echo "[entrypoint] ERRO: DATABASE_URL nao definida. Configure a env do container." >&2
  exit 1
fi

# --- 1) Schema do banco (pode ser pulado com SKIP_DB_INIT=true) ---
if [ "${SKIP_DB_INIT:-false}" != "true" ]; then
  echo "[entrypoint] Aplicando schema no banco (prisma db push, sem data loss)..."
  npx prisma db push --schema="$SCHEMA" --skip-generate

  # Índice único parcial SyncJob_dedupKey_active_key: db push não o cria (nem o remove).
  # A migration é idempotente (IF NOT EXISTS) e ABORTA com relatório se houver duplicatas
  # ativas de dedupKey — nesse caso o boot para AQUI (set -e) e a API não sobe.
  echo "[entrypoint] Aplicando migration P1 do SyncJob (indice parcial de dedup, idempotente)..."
  if ! npx prisma db execute \
      --file /app/apps/api/prisma/migrations/20260809_syncjob_dedup_lease/migration.sql \
      --schema="$SCHEMA"; then
    echo "[entrypoint] ERRO: migration P1 do SyncJob falhou (veja o relatorio acima)." >&2
    echo "[entrypoint] Se houver duplicatas ativas de dedupKey, resolva-as manualmente antes de subir a API." >&2
    exit 1
  fi
else
  echo "[entrypoint] SKIP_DB_INIT=true -> pulando prisma db push e a migration P1 do SyncJob."
fi

# --- 2) Seed idempotente (pode ser pulado com SKIP_SEED=true) ---
if [ "${SKIP_SEED:-false}" != "true" ]; then
  echo "[entrypoint] Rodando seed idempotente..."
  node /app/apps/api/prisma/seed.js || echo "[entrypoint] AVISO: seed falhou (nao-fatal), seguindo o boot."
else
  echo "[entrypoint] SKIP_SEED=true -> pulando seed."
fi

# --- 3) Sobe API e Web ---
export VISMED_API_PORT="${VISMED_API_PORT:-3000}"

echo "[entrypoint] Iniciando API na porta ${VISMED_API_PORT}..."
node /app/apps/api/dist/main.js &
API_PID=$!

echo "[entrypoint] Iniciando Web na porta 5000..."
( cd /app/apps/web && npx next start -p 5000 -H 0.0.0.0 ) &
WEB_PID=$!

# Encaminha SIGTERM/SIGINT para os processos filhos (shutdown limpo no Portainer).
term_handler() {
  echo "[entrypoint] Recebido sinal de parada, encerrando processos..."
  kill -TERM "$API_PID" "$WEB_PID" 2>/dev/null || true
  wait "$API_PID" "$WEB_PID" 2>/dev/null || true
  exit 0
}
trap term_handler SIGTERM SIGINT

# Se qualquer processo terminar, derruba o container para o Portainer reiniciar.
wait -n
EXIT_CODE=$?
echo "[entrypoint] Um dos processos terminou (exit=${EXIT_CODE}). Encerrando container."
kill -TERM "$API_PID" "$WEB_PID" 2>/dev/null || true
exit "$EXIT_CODE"
