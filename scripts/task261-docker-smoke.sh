#!/usr/bin/env bash
# Reproducible, isolated Docker smoke test for Task 261.
# Default: removes every Docker resource it creates.  --hold-preview leaves the
# validated app, postgres, redis, and internal network up for a screenshot.
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${TASK261_IMAGE:-vismed-task213:local}"
RUN_ID="task261-smoke-$(date +%s)-$$"
NETWORK="${RUN_ID}-net"
PG="${RUN_ID}-postgres"
REDIS="${RUN_ID}-redis"
APP="${RUN_ID}-preview"
OPTIN="${RUN_ID}-optin"
DB_BASE="task261_baseline"
DB_APPLIED="task261_applied"
HOLD=false
PORT=5513
LOG_DIR="${TASK261_SMOKE_LOG_DIR:-/tmp/task213-docker-smoke/$RUN_ID}"
LOG="$LOG_DIR/smoke.log"
SQL_DIR="$LOG_DIR/fixture"
mkdir -p "$SQL_DIR"

case "${1:-}" in
  "") ;;
  --hold-preview) HOLD=true ;;
  *) echo "usage: $0 [--hold-preview]" >&2; exit 64 ;;
esac

exec > >(tee -a "$LOG") 2>&1
echo "Task 261 Docker smoke run: $RUN_ID"
echo "Evidence log: $LOG"

cleanup() {
  local status=$?
  if "$HOLD" && [ "$status" -eq 0 ]; then
    cat <<EOF
PASS (preview held)
app=$APP
postgres=$PG
redis=$REDIS
network=$NETWORK (internal)
preview=http://127.0.0.1:$PORT
Cleanup exactly:
  docker rm -fv $APP $PG $REDIS
  docker network rm $NETWORK
EOF
    return
  fi
  docker rm -fv "$APP" "$OPTIN" "$PG" "$REDIS" >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
  echo "Cleanup complete for app=$APP postgres=$PG redis=$REDIS network=$NETWORK (status=$status)"
}
trap cleanup EXIT INT TERM

need() { command -v "$1" >/dev/null || { echo "missing required command: $1" >&2; exit 69; }; }
need docker
need node
need npx
need curl

docker info >/dev/null
echo "Building final image $IMAGE from Dockerfile"
if [ "${TASK261_SMOKE_REUSE_IMAGE:-false}" = "true" ]; then
  # Only for re-running test-harness checks; production files are compared below.
  docker image inspect "$IMAGE" >/dev/null
else
  docker build --tag "$IMAGE" "$ROOT"
fi

SOURCE_RUNNER="$ROOT/apps/api/scripts/task261/cli.js"
test -f "$SOURCE_RUNNER"
SOURCE_HASH="$(sha256sum "$SOURCE_RUNNER" | awk '{print $1}')"
IMAGE_HASH="$(docker run --rm --entrypoint node "$IMAGE" -e \
  "const c=require('crypto'),f=require('fs');process.stdout.write(c.createHash('sha256').update(f.readFileSync('/app/apps/api/scripts/task261/cli.js')).digest('hex'))")"
test "$SOURCE_HASH" = "$IMAGE_HASH"
ENTRYPOINT_HASH="$(sha256sum "$ROOT/docker-entrypoint.sh" | awk '{print $1}')"
IMAGE_ENTRYPOINT_HASH="$(docker run --rm --entrypoint node "$IMAGE" -e \
  "const c=require('crypto'),f=require('fs');process.stdout.write(c.createHash('sha256').update(f.readFileSync('/app/docker-entrypoint.sh')).digest('hex'))")"
test "$ENTRYPOINT_HASH" = "$IMAGE_ENTRYPOINT_HASH"
echo "Runner hash verified after prune: $SOURCE_HASH"

PRIOR="$SQL_DIR/pre-task261.prisma"
BASELINE_SQL="$SQL_DIR/pre-task261-from-empty.sql"
node "$ROOT/apps/api/scripts/task261-tests/generate-prior-datamodel.js" \
  --source "$ROOT/apps/api/prisma/schema.prisma" --output "$PRIOR"
(cd "$ROOT/apps/api" && npx prisma migrate diff --from-empty \
  --to-schema-datamodel "$PRIOR" --script) > "$BASELINE_SQL"
test -s "$BASELINE_SQL"
echo "Generated prior datamodel and from-empty fixture: $BASELINE_SQL"

# No service has a bind mount, a named volume, inherited environment, or an
# externally routable Docker network.
docker network create --internal "$NETWORK" >/dev/null
docker run -d --name "$PG" --network "$NETWORK" \
  --tmpfs /var/lib/postgresql/data \
  -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=postgres \
  postgres:16 >/dev/null
docker run -d --name "$REDIS" --network "$NETWORK" --tmpfs /data redis:7 \
  redis-server --save '' --appendonly no >/dev/null
pg_ready=false
for _ in $(seq 1 60); do
  if docker run --rm --network "$NETWORK" --entrypoint pg_isready postgres:16 \
    -h "$PG" -U postgres -d postgres >/dev/null 2>&1; then pg_ready=true; break; fi
  sleep 1
done
"$pg_ready"
redis_ready=false
for _ in $(seq 1 60); do
  if docker run --rm --network "$NETWORK" --entrypoint redis-cli redis:7 \
    -h "$REDIS" ping 2>/dev/null | grep -qx PONG; then redis_ready=true; break; fi
  sleep 1
done
"$redis_ready"
echo "Disposable postgres:16 and redis:7 ready on internal network $NETWORK"

psql() {
  docker run --rm -i --network "$NETWORK" --entrypoint psql postgres:16 \
    -X -v ON_ERROR_STOP=1 -h "$PG" -U postgres -d "$1" "${@:2}"
}
psql postgres -c "CREATE DATABASE \"$DB_BASE\""
psql "$DB_BASE" < "$BASELINE_SQL"
psql "$DB_BASE" <<'SQL'
CREATE TABLE "_prisma_migrations" (
  "id" varchar(36) PRIMARY KEY,
  "checksum" varchar(64) NOT NULL,
  "migration_name" varchar(255) NOT NULL
);
INSERT INTO "_prisma_migrations"
VALUES ('history-sentinel', repeat('a', 64), 'baseline_history_must_not_change');
CREATE TABLE "Task261Sentinel" ("id" integer PRIMARY KEY, "payload" text NOT NULL);
INSERT INTO "Task261Sentinel" VALUES (261, 'must survive byte-for-byte');
SQL
psql postgres -c "CREATE DATABASE \"$DB_APPLIED\" TEMPLATE \"$DB_BASE\""

DB_URL="postgresql://postgres@${PG}:5432/${DB_BASE}?schema=public"
APPLIED_URL="postgresql://postgres@${PG}:5432/${DB_APPLIED}?schema=public"
common_env=(
  --env "DATABASE_URL=$DB_URL"
  --env JWT_SECRET=task261-disposable-smoke-key-not-a-real-secret
  --env REDIS_HOST="$REDIS" --env REDIS_PORT=6379
  --env DISABLE_SYNC_CRON=true --env DISABLE_BLOCK_WATCHER=true
  --env DISABLE_TOKEN_REFRESHER=true --env DISABLE_BOOKING_SWEEP=true
  --env DOCTORALIA_TENANT_SAFE_DOCTOR_MATCH_CLINIC_IDS=
  --env DOCTORALIA_BASE_URL=http://doctoralia-blocked.invalid
  --env NODE_ENV=production
)

expect_exit() {
  local expected="$1"; shift
  set +e
  "$@"
  local actual=$?
  set -e
  if [ "$actual" -ne "$expected" ]; then
    echo "expected exit $expected, got $actual: $*" >&2
    exit 1
  fi
}
one_shot() {
  # shellcheck disable=SC2068
  docker run --rm --network "$NETWORK" ${common_env[@]} "$@"
}
probe_api() {
  local target="$1"
  docker run --rm --network "$NETWORK" --entrypoint node "$IMAGE" -e \
    "fetch('http://${target}:3000/').then(async r=>{if(!r.ok)process.exit(1);console.log(await r.text())}).catch(()=>process.exit(1))"
}
assert_no_services() {
  local output="$1"
  ! grep -Eq 'Iniciando API|Iniciando Web|Server is running' "$output"
}

echo "Checking missing DATABASE_URL"
expect_exit 23 docker run --rm --network "$NETWORK" "$IMAGE"

echo "Checking incompatible empty database"
expect_exit 22 docker run --rm --network "$NETWORK" \
  -e "DATABASE_URL=postgresql://postgres@${PG}:5432/postgres?schema=public" "$IMAGE"
echo "Checking empty and duplicate schema parameters"
expect_exit 23 docker run --rm --network "$NETWORK" \
  -e "DATABASE_URL=postgresql://postgres@${PG}:5432/${DB_BASE}?schema=" "$IMAGE" preflight-task261
expect_exit 23 docker run --rm --network "$NETWORK" \
  -e "DATABASE_URL=postgresql://postgres@${PG}:5432/${DB_BASE}?schema=public&schema=public" \
  "$IMAGE" preflight-task261

echo "Checking absent schema blocks normal boot and legacy bypass flags"
ABSENT_LOG="$LOG_DIR/absent.log"
set +e
one_shot --env APPLY_TASK261_MIGRATION=false "$IMAGE" >"$ABSENT_LOG" 2>&1
code=$?
set -e
test "$code" -eq 20
assert_no_services "$ABSENT_LOG"
expect_exit 20 one_shot --env RUN_MIGRATIONS=true \
  --env PRISMA_DB_PUSH=true --env APPLY_TASK261_MIGRATION=false "$IMAGE"

echo "Checking strict one-shot authorization and no service startup"
DENIED_LOG="$LOG_DIR/denied-migrate.log"
set +e
one_shot --env APPLY_TASK261_MIGRATION=false "$IMAGE" migrate-task261 >"$DENIED_LOG" 2>&1
code=$?
set -e
test "$code" -eq 23
assert_no_services "$DENIED_LOG"

echo "Applying only authorized SQL, then checking idempotency and preflight"
MIGRATE_LOG="$LOG_DIR/migrate.log"
one_shot --env APPLY_TASK261_MIGRATION=true "$IMAGE" migrate-task261 >"$MIGRATE_LOG" 2>&1
assert_no_services "$MIGRATE_LOG"
grep -Fq '[task261] migration committed' "$MIGRATE_LOG"
NOOP_LOG="$LOG_DIR/migrate-noop.log"
one_shot --env APPLY_TASK261_MIGRATION=true "$IMAGE" migrate-task261 >"$NOOP_LOG" 2>&1
grep -Fq '[task261] no DDL was required' "$NOOP_LOG"
one_shot "$IMAGE" preflight-task261
psql "$DB_BASE" -Atc \
  "SELECT payload || ':' || migration_name FROM \"Task261Sentinel\", \"_prisma_migrations\" WHERE \"Task261Sentinel\".id=261 AND \"_prisma_migrations\".id='history-sentinel'" \
  | grep -Fx 'must survive byte-for-byte:baseline_history_must_not_change'

echo "Checking UNLOGGED target relation is rejected"
psql postgres -c "CREATE DATABASE task261_unlogged TEMPLATE \"$DB_BASE\""
psql task261_unlogged -c 'ALTER TABLE "DoctoraliaCatalogAttemptBucket" SET UNLOGGED'
expect_exit 21 docker run --rm --network "$NETWORK" \
  -e "DATABASE_URL=postgresql://postgres@${PG}:5432/task261_unlogged?schema=public" \
  "$IMAGE" preflight-task261

echo "Checking wrong target schema is rejected"
psql "$DB_BASE" -c 'CREATE SCHEMA wrong_schema'
expect_exit 22 docker run --rm --network "$NETWORK" \
  -e "DATABASE_URL=postgresql://postgres@${PG}:5432/${DB_BASE}?schema=wrong_schema" \
  -e APPLY_TASK261_MIGRATION=true "$IMAGE" migrate-task261

echo "Installing PostgreSQL DDL audit for normal boot"
psql "$DB_BASE" <<'SQL'
CREATE TABLE task261_ddl_audit (tag text NOT NULL);
CREATE FUNCTION task261_ddl_audit_fn() RETURNS event_trigger LANGUAGE plpgsql AS $$
BEGIN INSERT INTO task261_ddl_audit(tag) VALUES (tg_tag); END $$;
CREATE EVENT TRIGGER task261_ddl_audit_trigger ON ddl_command_end
EXECUTE FUNCTION task261_ddl_audit_fn();
TRUNCATE task261_ddl_audit;
SQL

echo "Starting validated normal API + Web runtime"
docker run -d --name "$APP" --network "$NETWORK" -p "127.0.0.1:${PORT}:5000" \
  "${common_env[@]}" --env APPLY_TASK261_MIGRATION=false "$IMAGE" >/dev/null
web_ready=false
for _ in $(seq 1 60); do
  if [ "$(docker inspect --format '{{.State.Status}}' "$APP")" = "exited" ]; then
    docker logs "$APP"
    echo "Application exited before becoming ready" >&2
    exit 1
  fi
  if docker run --rm --network "$NETWORK" --entrypoint node "$IMAGE" -e \
    "fetch('http://$APP:5000/').then(async r=>{if(!r.ok)process.exit(1);console.log(await r.text())}).catch(()=>process.exit(1))" \
    >"$LOG_DIR/web-root.html"; then web_ready=true; break; fi
  sleep 1
done
"$web_ready"
test -s "$LOG_DIR/web-root.html"
if curl --fail --silent "http://127.0.0.1:${PORT}/" >/dev/null; then
  echo "Host preview port is reachable"
else
  echo "LIMITATION: published host port is not reachable here; real Web HTTP was verified on the isolated Docker network"
fi
# The Web server is real, and the API is reached from a one-off container
# because this host cannot start docker-exec processes.
probe_api "$APP" | tee "$LOG_DIR/api-root.txt"
psql "$DB_BASE" -Atc 'SELECT count(*) FROM task261_ddl_audit' | grep -qx 0
echo "Normal applied boot made no DDL (PostgreSQL event-trigger audit)"

echo "Checking opt-in normal boot on a fresh absent baseline"
docker run -d --name "$OPTIN" --network "$NETWORK" \
  -e "DATABASE_URL=$APPLIED_URL" -e REDIS_HOST="$REDIS" -e REDIS_PORT=6379 \
  -e JWT_SECRET=task261-disposable-smoke-key-not-a-real-secret \
  -e DISABLE_SYNC_CRON=true -e DISABLE_BLOCK_WATCHER=true \
  -e DISABLE_TOKEN_REFRESHER=true -e DISABLE_BOOKING_SWEEP=true \
  -e DOCTORALIA_TENANT_SAFE_DOCTOR_MATCH_CLINIC_IDS= \
  -e DOCTORALIA_BASE_URL=http://doctoralia-blocked.invalid \
  -e APPLY_TASK261_MIGRATION=true "$IMAGE" >/dev/null
optin_ready=false
for _ in $(seq 1 60); do
  if probe_api "$OPTIN" >/dev/null; then optin_ready=true; break; fi
  sleep 1
done
"$optin_ready"
probe_api "$OPTIN" >/dev/null
docker stop --time 15 "$OPTIN" >/dev/null
test "$(docker inspect -f '{{.State.Status}}' "$OPTIN")" = exited
test "$(docker inspect -f '{{.State.ExitCode}}' "$OPTIN")" = 0
docker rm -v "$OPTIN" >/dev/null
echo "SIGTERM shutdown completed cleanly"
echo "PASS: all Task 261 Docker smoke assertions passed."