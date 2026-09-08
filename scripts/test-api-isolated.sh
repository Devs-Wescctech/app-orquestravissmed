#!/usr/bin/env bash
# API regressions against a new local PostgreSQL cluster, never an inherited URL.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ "${TASK213_CLEAN_ENV:-}" != "1" ]; then
  exec env -i PATH="$PATH" HOME="$HOME" LANG=C.UTF-8 \
    TASK213_CLEAN_ENV=1 bash "$ROOT/scripts/test-api-isolated.sh" "$@"
fi

for binary in node initdb pg_ctl psql; do
  command -v "$binary" >/dev/null || {
    echo "Required local test tool unavailable: $binary" >&2
    exit 1
  }
done
TEMP="$(mktemp -d /tmp/vismed-api-regression.XXXXXX)"
cleanup() {
  pg_ctl -D "$TEMP/data" -m immediate -w stop >/dev/null 2>&1 || true
  rm -rf "$TEMP"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
PORT="$(node -e "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")"
initdb -D "$TEMP/data" -A trust -U isolated >/dev/null
pg_ctl -D "$TEMP/data" -l "$TEMP/server.log" \
  -o "-p $PORT -h 127.0.0.1 -k $TEMP" -w start >/dev/null
export DATABASE_URL="postgresql://isolated@127.0.0.1:$PORT/postgres?schema=public"
cd "$ROOT"
node node_modules/prisma/build/index.js migrate diff --from-empty \
  --to-schema-datamodel apps/api/prisma/schema.prisma --script > "$TEMP/fixture.sql"
psql -X -h 127.0.0.1 -p "$PORT" -U isolated -d postgres \
  -v ON_ERROR_STOP=1 -f "$TEMP/fixture.sql" >/dev/null
# Fixture for the pre-existing queue invariant, not a replay of its migration.
psql -X -h 127.0.0.1 -p "$PORT" -U isolated -d postgres -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
CREATE UNIQUE INDEX "SyncJob_dedupKey_active_key" ON "SyncJob" ("dedupKey")
WHERE "dedupKey" IS NOT NULL AND status IN ('PENDING', 'RUNNING', 'FAILED');
SQL
cd "$ROOT/apps/api"
node "$ROOT/node_modules/jest/bin/jest.js" --runInBand "$@"