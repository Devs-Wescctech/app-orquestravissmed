#!/usr/bin/env bash
# Inicializacao do container unico VisMed (API NestJS + Web Next.js).
# O unico schema mutavel por este entrypoint e o da Task 261, com opt-in explicito.
set -euo pipefail

TASK261_RUNNER="/app/apps/api/scripts/task261/cli.js"

if [ -z "${DATABASE_URL:-}" ]; then
  echo "[entrypoint] ERRO: DATABASE_URL nao definida. Configure a env do container." >&2
  exit 23
fi

case "${1:-}" in
  migrate-task261)
    echo "[entrypoint] Executando migration controlada da Task 261 (one-shot)..."
    exec node "$TASK261_RUNNER" migrate
    ;;
  preflight-task261)
    echo "[entrypoint] Executando preflight read-only da Task 261..."
    exec node "$TASK261_RUNNER" preflight
    ;;
  "")
    ;;
  *)
    echo "[entrypoint] ERRO: comando desconhecido." >&2
    echo "[entrypoint] Use migrate-task261, preflight-task261 ou nenhum comando para o boot normal." >&2
    exit 23
    ;;
esac

# O runner tambem exige o opt-in. Flags legadas de inicializacao sao ignoradas:
# nao ha db push, seed, replay ou bypass do preflight neste entrypoint.
if [ "${APPLY_TASK261_MIGRATION:-false}" = "true" ]; then
  echo "[entrypoint] Opt-in confirmado; executando migration controlada da Task 261..."
  node "$TASK261_RUNNER" migrate
fi

echo "[entrypoint] Validando schema da Task 261 (read-only)..."
node "$TASK261_RUNNER" preflight

export VISMED_API_PORT="${VISMED_API_PORT:-3000}"

echo "[entrypoint] Iniciando API na porta ${VISMED_API_PORT}..."
node /app/apps/api/dist/main.js &
API_PID=$!

echo "[entrypoint] Iniciando Web na porta 5000..."
( cd /app/apps/web && exec node /app/node_modules/next/dist/bin/next start -p 5000 -H 0.0.0.0 ) &
WEB_PID=$!

# Encaminha SIGTERM/SIGINT para os processos filhos (shutdown limpo no Portainer).
term_handler() {
  echo "[entrypoint] Recebido sinal de parada, encerrando processos..."
  kill -TERM "$API_PID" "$WEB_PID" 2>/dev/null || true
  wait "$API_PID" "$WEB_PID" 2>/dev/null || true
  exit 0
}
trap term_handler SIGTERM SIGINT

# Se qualquer processo terminar, derruba o outro e colhe ambos. O set -e precisa
# ser suspenso ao redor de wait -n para que uma falha ainda passe pela limpeza.
set +e
wait -n
EXIT_CODE=$?
set -e
echo "[entrypoint] Um dos processos terminou (exit=${EXIT_CODE}). Encerrando container."
kill -TERM "$API_PID" "$WEB_PID" 2>/dev/null || true
wait "$API_PID" "$WEB_PID" 2>/dev/null || true
exit "$EXIT_CODE"
