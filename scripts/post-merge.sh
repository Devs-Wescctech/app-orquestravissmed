#!/bin/bash
# Post-merge setup para o monorepo VisMed (npm workspaces).
# Reconciliação idempotente após merge de task: deps + Prisma client + schema + build da API.
# Não-interativo (stdin fechado) e fail-fast.
set -euo pipefail

cd "$(dirname "$0")/.."

echo "[post-merge] Instalando dependências (npm workspaces)..."
npm install --no-audit --no-fund

echo "[post-merge] Gerando Prisma Client..."
npm run --workspace=apps/api exec -- prisma generate 2>/dev/null || (cd apps/api && npx prisma generate)

echo "[post-merge] Sincronizando schema do banco (prisma db push, idempotente)..."
# Sem migration_lock.toml o caminho é db push (não migrate deploy). SEM --accept-data-loss
# de propósito: mudanças destrutivas devem falhar aqui em vez de apagar dados silenciosamente.
(cd apps/api && npx prisma db push --skip-generate)

echo "[post-merge] Buildando a API (tsc → apps/api/dist)..."
# A API builda com tsc (não há nest-cli.json). O workflow roda apps/api/dist/main.js.
(cd apps/api && npx tsc)

echo "[post-merge] Concluído."
