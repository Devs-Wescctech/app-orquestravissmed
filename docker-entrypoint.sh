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
else
  echo "[entrypoint] SKIP_DB_INIT=true -> pulando prisma db push."
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
