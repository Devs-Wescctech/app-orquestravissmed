'use strict';

const assert = require('node:assert/strict');
const { execFile, spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { promisify } = require('node:util');
const { priorTask261Datamodel } = require('./generate-prior-datamodel');

const execFileAsync = promisify(execFile);
const apiRoot = path.resolve(__dirname, '../..');
const runner = path.join(apiRoot, 'scripts/task261/cli.js');
const migration = path.join(
  apiRoot,
  'prisma/migrations/20260904_doctoralia_tenant_catalog/migration.sql',
);
const schemaFile = path.join(apiRoot, 'prisma/schema.prisma');
const { MIGRATION_SHA256, migrationSha256 } = require('../task261/cli');

let cluster;
let databaseSequence = 0;

test('migration integrity hash accepts LF and CRLF representations of the authorized SQL', () => {
  const lf = fs.readFileSync(migration, 'utf8').replace(/\r\n?/g, '\n');
  const crlf = lf.replace(/\n/g, '\r\n');

  assert.equal(migrationSha256(lf), MIGRATION_SHA256);
  assert.equal(migrationSha256(crlf), MIGRATION_SHA256);
  assert.notEqual(migrationSha256(`${lf}\n-- unauthorized change`), MIGRATION_SHA256);
});

function cleanEnvironment(extra = {}) {
  // Deliberately do not spread process.env: in particular, an inherited
  // DATABASE_URL must never be visible to a child used by these tests.
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    USER: process.env.USER,
    LOGNAME: process.env.LOGNAME,
    LANG: process.env.LANG || 'C.UTF-8',
    LC_ALL: 'C',
    ...extra,
  };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete env[key];
  }
  return env;
}

async function freeLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

async function command(file, args, options = {}) {
  return execFileAsync(file, args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    ...options,
    env: cleanEnvironment(options.env),
  });
}

function connectionUrl(database, schema) {
  const base = `postgresql://task261_test@127.0.0.1:${cluster.port}/${database}`;
  // The runner's public schema-target interface is DATABASE_URL?schema=<name>.
  // Do not depend on a role/database search_path when selecting the target.
  return schema ? `${base}?schema=${encodeURIComponent(schema)}` : base;
}

async function psql(database, sql, options = {}) {
  const args = [
    '-X', '-v', 'ON_ERROR_STOP=1',
    '-h', '127.0.0.1',
    '-p', String(cluster.port),
    '-U', 'task261_test',
    '-d', database,
  ];
  if (options.file) args.push('-f', options.file);
  else args.push('-c', sql);
  return command('psql', args);
}

async function buildBaselineDatabase() {
  const baselineSchema = path.join(cluster.root, 'baseline.prisma');
  const baselineSql = path.join(cluster.root, 'baseline.sql');
  const current = fs.readFileSync(schemaFile, 'utf8');
  fs.writeFileSync(baselineSchema, priorTask261Datamodel(current));

  // npm workspaces may hoist the executable to the repository root.
  const localPrisma = path.join(apiRoot, 'node_modules/.bin/prisma');
  const prisma = fs.existsSync(localPrisma)
    ? localPrisma
    : path.resolve(apiRoot, '../../node_modules/.bin/prisma');
  const { stdout } = await command(
    prisma,
    [
      'migrate',
      'diff',
      '--from-empty',
      '--to-schema-datamodel',
      baselineSchema,
      '--script',
    ],
    { cwd: apiRoot },
  );
  fs.writeFileSync(baselineSql, stdout);
  await psql('postgres', 'CREATE DATABASE task261_baseline');
  await psql('task261_baseline', undefined, { file: baselineSql });
  await psql(
    'task261_baseline',
    `
      CREATE TABLE "_prisma_migrations" (
        "id" varchar(36) PRIMARY KEY,
        "checksum" varchar(64) NOT NULL,
        "migration_name" varchar(255) NOT NULL
      );
      INSERT INTO "_prisma_migrations" VALUES
        ('history-sentinel', repeat('a', 64), 'baseline_history_must_not_change');
      CREATE TABLE "Task261Sentinel" ("id" integer PRIMARY KEY, "payload" text NOT NULL);
      INSERT INTO "Task261Sentinel" VALUES (261, 'must survive byte-for-byte');
    `,
  );
}

async function newDatabase({ schema } = {}) {
  databaseSequence += 1;
  const name = `task261_case_${databaseSequence}`;
  await psql('postgres', `CREATE DATABASE ${name} TEMPLATE task261_baseline`);
  if (schema) {
    await psql(name, `ALTER SCHEMA public RENAME TO ${schema}`);
    await psql(name, `ALTER DATABASE ${name} SET search_path TO ${schema}`);
  }
  return { name, schema, url: connectionUrl(name, schema) };
}

async function emptyDatabase() {
  databaseSequence += 1;
  const name = `task261_empty_${databaseSequence}`;
  await psql('postgres', `CREATE DATABASE ${name}`);
  return { name, url: connectionUrl(name) };
}

async function runCli(mode, db, flag, extraEnv = {}) {
  const env = {
    DATABASE_URL: db.url,
    ...extraEnv,
  };
  if (flag !== undefined) env.APPLY_TASK261_MIGRATION = flag;
  try {
    const result = await command(process.execPath, [runner, mode], { cwd: apiRoot, env });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      code: error.code,
      stdout: error.stdout || '',
      stderr: error.stderr || '',
    };
  }
}

function spawnCli(mode, db, flag) {
  const env = cleanEnvironment({
    DATABASE_URL: db.url,
    APPLY_TASK261_MIGRATION: flag,
  });
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [runner, mode], {
      cwd: apiRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function applyRawMigration(db) {
  await psql(db.name, undefined, {
    file: migration,
  });
}

async function stateFingerprint(db) {
  const { stdout } = await psql(
    db.name,
    `
      SELECT jsonb_build_object(
        'history', (SELECT jsonb_agg(to_jsonb(m) ORDER BY migration_name) FROM "_prisma_migrations" m),
        'sentinel', (SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM "Task261Sentinel" s),
        'objects', (
          SELECT jsonb_agg(x ORDER BY x)
          FROM (
            SELECT c.relkind::text || ':' || n.nspname || '.' || c.relname AS x
            FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = current_schema() AND c.relkind IN ('r', 'i')
          ) q
        )
      )::text;
    `,
  );
  return stdout.trim();
}

async function expectCode(mode, db, expected, flag) {
  const result = await runCli(mode, db, flag);
  assert.equal(
    result.code,
    expected,
    `${mode} expected ${expected}, got ${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return result;
}

test.before(async () => {
  assert.equal(
    fs.existsSync(runner),
    true,
    `Task 261 runner is required at ${runner}`,
  );
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task261-pg-'));
  const data = path.join(root, 'data');
  const socket = path.join(root, 'socket');
  fs.mkdirSync(socket);
  const port = await freeLoopbackPort();
  cluster = { root, data, socket, port };

  await command('initdb', [
    '-D',
    data,
    '--username=task261_test',
    '--no-locale',
    '--encoding=UTF8',
    '--auth=trust',
  ]);
  fs.appendFileSync(
    path.join(data, 'postgresql.conf'),
    `
listen_addresses = '127.0.0.1'
port = ${port}
unix_socket_directories = '${socket.replaceAll("'", "''")}'
fsync = off
synchronous_commit = off
full_page_writes = off
`,
  );
  fs.appendFileSync(
    path.join(data, 'pg_hba.conf'),
    '\nhost all all 127.0.0.1/32 trust\n',
  );
  // Redirect the postmaster itself: otherwise it inherits execFile's pipes and
  // keeps them open after pg_ctl exits, so the harness waits forever.
  await command('pg_ctl', [
    '-D',
    data,
    '-l',
    path.join(root, 'server.log'),
    '-w',
    'start',
  ]);
  await buildBaselineDatabase();
});

test.after(async () => {
  if (!cluster) return;
  try {
    await command('pg_ctl', ['-D', cluster.data, '-m', 'immediate', '-w', 'stop']);
  } finally {
    fs.rmSync(cluster.root, { recursive: true, force: true });
  }
});

test('preflight distinguishes absent, baseline, applied, and partial states', async (t) => {
  await t.test('absent database', async () => {
    await expectCode('preflight', await emptyDatabase(), 22);
  });

  await t.test('exact pre-task baseline', async () => {
    await expectCode('preflight', await newDatabase(), 20);
  });

  await t.test('fully applied', async () => {
    const db = await newDatabase();
    await applyRawMigration(db);
    await expectCode('preflight', db, 0);
  });

  await t.test('one task table is a partial state', async () => {
    const db = await newDatabase();
    await psql(
      db.name,
      `CREATE TABLE "DoctoraliaCatalogAttemptBucket" (
        "bucketStart" TIMESTAMP(3) PRIMARY KEY,
        "attempts" INTEGER NOT NULL DEFAULT 0,
        "updatedAt" TIMESTAMP(3) NOT NULL
      )`,
    );
    await expectCode('preflight', db, 21);
  });
});

test('preflight rejects subtly malformed task schemas', async (t) => {
  const cases = [
    {
      name: 'wrong catalogScopeVersion column type',
      mutate: `ALTER TABLE "IntegrationConnection"
        ALTER COLUMN "catalogScopeVersion" TYPE bigint`,
    },
    {
      name: 'wrong catalogScopeVersion default',
      mutate: `ALTER TABLE "IntegrationConnection"
        ALTER COLUMN "catalogScopeVersion" SET DEFAULT 2`,
    },
    {
      name: 'missing required composite index',
      mutate: `DROP INDEX "DoctoraliaCatalogGeneration_expiresAt_idx"`,
    },
    {
      name: 'wrong composite tenant foreign key',
      mutate: `
        ALTER TABLE "DoctoraliaCatalogGeneration"
          DROP CONSTRAINT "DoctoraliaCatalogGeneration_connectionId_clinicId_fkey";
        ALTER TABLE "DoctoraliaCatalogGeneration"
          ADD CONSTRAINT "DoctoraliaCatalogGeneration_connectionId_clinicId_fkey"
          FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE
      `,
    },
    {
      name: 'required foreign key is unvalidated',
      mutate: `
        ALTER TABLE "DoctoraliaCatalogLease"
          DROP CONSTRAINT "DoctoraliaCatalogLease_connectionId_clinicId_fkey";
        ALTER TABLE "DoctoraliaCatalogLease"
          ADD CONSTRAINT "DoctoraliaCatalogLease_connectionId_clinicId_fkey"
          FOREIGN KEY ("connectionId", "clinicId")
          REFERENCES "IntegrationConnection"("id", "clinicId")
          ON DELETE CASCADE ON UPDATE CASCADE NOT VALID
      `,
    },
    {
      name: 'task table is UNLOGGED',
      mutate: `ALTER TABLE "DoctoraliaCatalogAttemptBucket" SET UNLOGGED`,
    },
    {
      name: 'identity column is rejected',
      mutate: `
        ALTER TABLE "IntegrationConnection"
          ALTER COLUMN "catalogScopeVersion" DROP DEFAULT;
        ALTER TABLE "IntegrationConnection"
          ALTER COLUMN "catalogScopeVersion" ADD GENERATED BY DEFAULT AS IDENTITY
      `,
    },
    {
      name: 'generated column is rejected',
      mutate: `
        ALTER TABLE "DoctoraliaCatalogMember" DROP COLUMN "facilityId" CASCADE;
        ALTER TABLE "DoctoraliaCatalogMember"
          ADD COLUMN "facilityId" text GENERATED ALWAYS AS ('forced') STORED;
        ALTER TABLE "DoctoraliaCatalogMember" ALTER COLUMN "facilityId" SET NOT NULL;
        CREATE UNIQUE INDEX "DoctoraliaCatalogMember_generationId_facilityId_doctoraliaE_key"
          ON "DoctoraliaCatalogMember"("generationId", "facilityId", "doctoraliaExternalId")
      `,
    },
    {
      name: 'NULLS NOT DISTINCT index is rejected',
      mutate: `
        DROP INDEX "DoctoraliaCatalogCredential_memberId_council_number_uf_regi_key";
        CREATE UNIQUE INDEX "DoctoraliaCatalogCredential_memberId_council_number_uf_regi_key"
          ON "DoctoraliaCatalogCredential"
          ("memberId", "council", "number", "uf", "regional") NULLS NOT DISTINCT
      `,
    },
    {
      name: 'foreign key into another schema is rejected',
      mutate: `
        ALTER TABLE "DoctoraliaCatalogGeneration"
          DROP CONSTRAINT "DoctoraliaCatalogGeneration_connectionId_clinicId_fkey";
        CREATE SCHEMA task261_wrong_reference;
        CREATE TABLE task261_wrong_reference."IntegrationConnection" (
          "id" text NOT NULL,
          "clinicId" text NOT NULL,
          UNIQUE ("id", "clinicId")
        );
        ALTER TABLE "DoctoraliaCatalogGeneration"
          ADD CONSTRAINT "DoctoraliaCatalogGeneration_connectionId_clinicId_fkey"
          FOREIGN KEY ("connectionId", "clinicId")
          REFERENCES task261_wrong_reference."IntegrationConnection"("id", "clinicId")
          ON DELETE CASCADE ON UPDATE CASCADE
      `,
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const db = await newDatabase();
      await applyRawMigration(db);
      await psql(db.name, item.mutate);
      await expectCode('preflight', db, 21);
      const before = await stateFingerprint(db);
      await expectCode('migrate', db, 21, 'true');
      assert.equal(await stateFingerprint(db), before, 'migrate must not repair an unsafe partial state');
    });
  }
});

test('migrate requires the exact lowercase true safety flag', async (t) => {
  for (const flag of [undefined, '', 'false', 'TRUE', '1', ' true']) {
    await t.test(flag === undefined ? 'missing flag' : `flag ${JSON.stringify(flag)}`, async () => {
      const db = await newDatabase();
      const before = await stateFingerprint(db);
      await expectCode('migrate', db, 23, flag);
      assert.equal(await stateFingerprint(db), before);
      await expectCode('preflight', db, 20);
    });
  }

  await t.test('authorization is still required when already applied', async () => {
    const db = await newDatabase();
    await applyRawMigration(db);
    const before = await stateFingerprint(db);
    await expectCode('migrate', db, 23);
    assert.equal(await stateFingerprint(db), before);
  });
});

test('rejects empty and duplicate schema URL parameters before connecting', async () => {
  const db = await newDatabase();
  for (const suffix of ['?schema=', '?schema=public&schema=other']) {
    const malformed = { ...db, url: connectionUrl(db.name) + suffix };
    const result = await expectCode('preflight', malformed, 23);
    assert.doesNotMatch(result.stderr, /127\.0\.0\.1|task261_case_/);
  }
});

test('rejects an UNLOGGED historical baseline table', async () => {
  const db = await emptyDatabase();
  await psql(
    db.name,
    `
      CREATE UNLOGGED TABLE "Clinic" ("id" text PRIMARY KEY);
      CREATE UNLOGGED TABLE "IntegrationConnection" (
        "id" text PRIMARY KEY,
        "clinicId" text NOT NULL,
        CONSTRAINT "IntegrationConnection_clinicId_fkey"
          FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id")
          ON DELETE CASCADE ON UPDATE CASCADE
      );
      CREATE UNLOGGED TABLE "DoctoraliaDoctor" ("id" text PRIMARY KEY);
    `,
  );
  await expectCode('preflight', db, 22);
  await expectCode('migrate', db, 22, 'true');
  const { stdout } = await psql(
    db.name,
    `SELECT count(*) FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'IntegrationConnection'
        AND column_name = 'catalogScopeVersion'`,
  );
  assert.match(stdout, /\b0\b/);
});

test('rejects a reserved Task 261 constraint name owned by an unrelated table', async () => {
  const db = await newDatabase();
  await psql(
    db.name,
    `ALTER TABLE "Task261Sentinel"
      ADD CONSTRAINT "DoctoraliaCatalogGeneration_pkey" UNIQUE ("payload")`,
  );
  await expectCode('preflight', db, 21);
  await expectCode('migrate', db, 21, 'true');
});

test('migration SQL hash failure is sanitized and cannot mutate the database', async () => {
  const db = await newDatabase();
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'task261-runner-sandbox-'));
  try {
    const sandboxRunner = path.join(sandbox, 'apps/api/scripts/task261/cli.js');
    const sandboxMigration = path.join(
      sandbox,
      'apps/api/prisma/migrations/20260904_doctoralia_tenant_catalog/migration.sql',
    );
    fs.mkdirSync(path.dirname(sandboxRunner), { recursive: true });
    fs.mkdirSync(path.dirname(sandboxMigration), { recursive: true });
    fs.copyFileSync(runner, sandboxRunner);
    fs.writeFileSync(
      sandboxMigration,
      `${fs.readFileSync(migration, 'utf8')}\n-- deliberate sandbox-only hash mismatch\n`,
    );
    fs.symlinkSync(path.resolve(apiRoot, '../../node_modules'), path.join(sandbox, 'node_modules'));

    const before = await stateFingerprint(db);
    let result;
    try {
      await command(process.execPath, [sandboxRunner, 'migrate'], {
        env: {
          DATABASE_URL: db.url,
          APPLY_TASK261_MIGRATION: 'true',
        },
      });
      result = { code: 0, stderr: '' };
    } catch (error) {
      result = { code: error.code, stderr: error.stderr || '' };
    }
    assert.equal(result.code, 24);
    assert.doesNotMatch(result.stderr, /sha|hash|migration\.sql|127\.0\.0\.1/i);
    assert.equal(await stateFingerprint(db), before);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test('migrate applies once, is a no-op subsequently, and preserves unrelated state', async () => {
  const db = await newDatabase();
  const originalSentinels = await stateFingerprint(db);
  await expectCode('migrate', db, 0, 'true');
  await expectCode('preflight', db, 0);

  const afterFirst = await stateFingerprint(db);
  assert.notEqual(afterFirst, originalSentinels, 'migration should add its schema objects');
  const { stdout: rows } = await psql(
    db.name,
    `SELECT
       (SELECT payload FROM "Task261Sentinel" WHERE id = 261),
       (SELECT migration_name FROM "_prisma_migrations" WHERE id = 'history-sentinel')`,
  );
  assert.match(rows, /must survive byte-for-byte/);
  assert.match(rows, /baseline_history_must_not_change/);

  await expectCode('migrate', db, 0, 'true');
  assert.equal(await stateFingerprint(db), afterFirst, 'second migrate must be a strict no-op');

  await psql(
    db.name,
    `
      CREATE TABLE "Task261DdlAudit" ("statement" text NOT NULL);
      CREATE FUNCTION task261_test_audit_ddl() RETURNS event_trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        INSERT INTO "Task261DdlAudit" VALUES (current_query());
      END $$;
      CREATE EVENT TRIGGER task261_test_ddl_audit
        ON ddl_command_start EXECUTE FUNCTION task261_test_audit_ddl();
    `,
  );
  await expectCode('migrate', db, 0, 'true');
  const { stdout: ddlCount } = await psql(db.name, 'SELECT count(*) FROM "Task261DdlAudit"');
  assert.match(ddlCount, /\b0\b/, 'applied no-op must issue no DDL');
});

test('concurrent migrators serialize safely', async () => {
  const db = await newDatabase();
  const results = await Promise.all([
    spawnCli('migrate', db, 'true'),
    spawnCli('migrate', db, 'true'),
  ]);
  for (const result of results) {
    assert.equal(
      result.code,
      0,
      `concurrent migrate failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  await expectCode('preflight', db, 0);
});

test('a database-side mid-migration fault rolls the whole migration back', async () => {
  const db = await newDatabase();
  const before = await stateFingerprint(db);
  await psql(
    db.name,
    `
      CREATE FUNCTION task261_test_reject_member() RETURNS event_trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF current_query() LIKE '%CREATE TABLE "DoctoraliaCatalogMember"%' THEN
          RAISE EXCEPTION 'task261 injected test fault';
        END IF;
      END $$;
      CREATE EVENT TRIGGER task261_test_midmigration
        ON ddl_command_start EXECUTE FUNCTION task261_test_reject_member();
    `,
  );

  await expectCode('migrate', db, 24, 'true');
  await psql(
    db.name,
    'DROP EVENT TRIGGER task261_test_midmigration; DROP FUNCTION task261_test_reject_member()',
  );

  assert.equal(
    await stateFingerprint(db),
    before,
    'all task DDL must roll back after a mid-migration database error',
  );
  await expectCode('preflight', db, 20);
});

test('works when the baseline lives in an independent non-public schema', async () => {
  const db = await newDatabase({ schema: 'task261_isolated' });
  await expectCode('preflight', db, 20);
  await expectCode('migrate', db, 0, 'true');
  await expectCode('preflight', db, 0);

  const { stdout } = await psql(
    db.name,
    `SELECT count(*) FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relname LIKE 'DoctoraliaCatalog%'`,
  );
  assert.match(stdout, /\b0\b/);
});
