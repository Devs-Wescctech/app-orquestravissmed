#!/bin/bash
# Post-merge setup para o monorepo VisMed (npm workspaces).
# Reconciliação idempotente após merge: deps + Prisma client + build da API.
# Nunca conecta ou altera bancos; schema exige operação explícita separada.
# Não-interativo (stdin fechado) e fail-fast.
set -euo pipefail

cd "$(dirname "$0")/.."

echo "[post-merge] Instalando dependências (npm workspaces)..."
npm install --no-audit --no-fund

echo "[post-merge] Gerando Prisma Client..."
npm run --workspace=apps/api exec -- prisma generate 2>/dev/null || (cd apps/api && npx prisma generate)

echo "[post-merge] Schema não é alterado no merge; use o procedimento controlado documentado."

echo "[post-merge] Buildando a API (tsc → apps/api/dist)..."
# A API builda com tsc (não há nest-cli.json). O workflow roda apps/api/dist/main.js.
(cd apps/api && npx tsc)

echo "[post-merge] Concluído."
