'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const EXIT = Object.freeze({
  applied: 0,
  absent: 20,
  partial: 21,
  baseline_incompatible: 22,
  config: 23,
  runtime: 24,
});

const TABLES = Object.freeze({
  DoctoraliaCatalogGeneration: {
    columns: {
      id: ['text', false, null],
      clinicId: ['text', false, null],
      connectionId: ['text', false, null],
      catalogScopeVersion: ['integer', false, null],
      facilityCount: ['integer', false, null],
      doctorCount: ['integer', false, null],
      publishedAt: ['timestamp(3) without time zone', false, 'now'],
      expiresAt: ['timestamp(3) without time zone', false, null],
    },
    constraints: {
      DoctoraliaCatalogGeneration_pkey: ['p', ['id'], null, null, null, null],
      DoctoraliaCatalogGeneration_clinicId_fkey: ['f', ['clinicId'], 'Clinic', ['id'], 'c', 'c'],
      DoctoraliaCatalogGeneration_connectionId_clinicId_fkey: [
        'f', ['connectionId', 'clinicId'], 'IntegrationConnection', ['id', 'clinicId'], 'c', 'c',
      ],
    },
    indexes: {
      DoctoraliaCatalogGeneration_pkey: [true, true, ['id']],
      DoctoraliaCatalogGeneration_clinicId_connectionId_catalogSc_idx: [
        false, false, ['clinicId', 'connectionId', 'catalogScopeVersion', 'publishedAt'],
      ],
      DoctoraliaCatalogGeneration_expiresAt_idx: [false, false, ['expiresAt']],
    },
  },
  DoctoraliaCatalogMember: {
    columns: {
      id: ['text', false, null],
      generationId: ['text', false, null],
      facilityId: ['text', false, null],
      doctoraliaDoctorId: ['text', false, null],
      doctoraliaExternalId: ['text', false, null],
      createdAt: ['timestamp(3) without time zone', false, 'now'],
    },
    constraints: {
      DoctoraliaCatalogMember_pkey: ['p', ['id'], null, null, null, null],
      DoctoraliaCatalogMember_generationId_fkey: [
        'f', ['generationId'], 'DoctoraliaCatalogGeneration', ['id'], 'c', 'c',
      ],
      DoctoraliaCatalogMember_doctoraliaDoctorId_fkey: [
        'f', ['doctoraliaDoctorId'], 'DoctoraliaDoctor', ['id'], 'r', 'c',
      ],
    },
    indexes: {
      DoctoraliaCatalogMember_pkey: [true, true, ['id']],
      DoctoraliaCatalogMember_generationId_facilityId_doctoraliaE_key: [
        true, false, ['generationId', 'facilityId', 'doctoraliaExternalId'],
      ],
      DoctoraliaCatalogMember_generationId_doctoraliaDoctorId_idx: [
        false, false, ['generationId', 'doctoraliaDoctorId'],
      ],
    },
  },
  DoctoraliaCatalogCredential: {
    columns: {
      id: ['text', false, null],
      memberId: ['text', false, null],
      council: ['text', false, null],
      number: ['text', false, null],
      uf: ['text', true, null],
      regional: ['text', true, null],
      createdAt: ['timestamp(3) without time zone', false, 'now'],
    },
    constraints: {
      DoctoraliaCatalogCredential_pkey: ['p', ['id'], null, null, null, null],
      DoctoraliaCatalogCredential_memberId_fkey: [
        'f', ['memberId'], 'DoctoraliaCatalogMember', ['id'], 'c', 'c',
      ],
    },
    indexes: {
      DoctoraliaCatalogCredential_pkey: [true, true, ['id']],
      DoctoraliaCatalogCredential_memberId_council_number_uf_regi_key: [
        true, false, ['memberId', 'council', 'number', 'uf', 'regional'],
      ],
      DoctoraliaCatalogCredential_council_number_uf_regional_idx: [
        false, false, ['council', 'number', 'uf', 'regional'],
      ],
      DoctoraliaCatalogCredential_memberId_idx: [false, false, ['memberId']],
    },
  },
  DoctoraliaCatalogLease: {
    columns: {
      connectionId: ['text', false, null],
      clinicId: ['text', false, null],
      owner: ['text', false, null],
      expiresAt: ['timestamp(3) without time zone', false, null],
      updatedAt: ['timestamp(3) without time zone', false, null],
    },
    constraints: {
      DoctoraliaCatalogLease_pkey: ['p', ['connectionId'], null, null, null, null],
      DoctoraliaCatalogLease_clinicId_fkey: ['f', ['clinicId'], 'Clinic', ['id'], 'c', 'c'],
      DoctoraliaCatalogLease_connectionId_clinicId_fkey: [
        'f', ['connectionId', 'clinicId'], 'IntegrationConnection', ['id', 'clinicId'], 'c', 'c',
      ],
    },
    indexes: {
      DoctoraliaCatalogLease_pkey: [true, true, ['connectionId']],
      DoctoraliaCatalogLease_clinicId_expiresAt_idx: [false, false, ['clinicId', 'expiresAt']],
      DoctoraliaCatalogLease_connectionId_clinicId_key: [
        true, false, ['connectionId', 'clinicId'],
      ],
    },
  },
  DoctoraliaCatalogAttemptBucket: {
    columns: {
      bucketStart: ['timestamp(3) without time zone', false, null],
      attempts: ['integer', false, '0'],
      updatedAt: ['timestamp(3) without time zone', false, null],
    },
    constraints: {
      DoctoraliaCatalogAttemptBucket_pkey: ['p', ['bucketStart'], null, null, null, null],
    },
    indexes: {
      DoctoraliaCatalogAttemptBucket_pkey: [true, true, ['bucketStart']],
    },
  },
});

const CONNECTION_INDEX = Object.freeze([
  true, false, ['id', 'clinicId'],
]);

const MIGRATION_PATH = path.resolve(
  __dirname, '../../prisma/migrations/20260904_doctoralia_tenant_catalog/migration.sql',
);
const MIGRATION_SHA256 = 'c0cbd06a3de7a4c49cf5769fb6aa3dd42d1ec416745f4965416e35e95213fce5';

function loadAuthorizedMigration() {
  const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
  const hash = crypto.createHash('sha256').update(sql, 'utf8').digest('hex');
  if (hash !== MIGRATION_SHA256) throw new Error('migration_sql_hash_mismatch');
  return sql;
}

// Exported for contract tests; execution always reloads and verifies this exact file.
let MIGRATION_SQL = null;
try {
  MIGRATION_SQL = loadAuthorizedMigration();
} catch {
  // The runner reloads below and reports a sanitized runtime failure.
}

const CATALOG_SQL = `
WITH relations AS (
  SELECT c.oid, c.relname, c.relkind, c.relpersistence
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = $1 AND (
    c.relkind IN ('r','p') OR
    c.relname IN (
      'DoctoraliaCatalogGeneration', 'DoctoraliaCatalogMember',
      'DoctoraliaCatalogCredential', 'DoctoraliaCatalogLease',
      'DoctoraliaCatalogAttemptBucket', 'IntegrationConnection_id_clinicId_key',
      'DoctoraliaCatalogGeneration_pkey', 'DoctoraliaCatalogGeneration_clinicId_connectionId_catalogSc_idx',
      'DoctoraliaCatalogGeneration_expiresAt_idx', 'DoctoraliaCatalogMember_pkey',
      'DoctoraliaCatalogMember_generationId_facilityId_doctoraliaE_key',
      'DoctoraliaCatalogMember_generationId_doctoraliaDoctorId_idx', 'DoctoraliaCatalogCredential_pkey',
      'DoctoraliaCatalogCredential_memberId_council_number_uf_regi_key',
      'DoctoraliaCatalogCredential_council_number_uf_regional_idx', 'DoctoraliaCatalogCredential_memberId_idx',
      'DoctoraliaCatalogLease_pkey', 'DoctoraliaCatalogLease_clinicId_expiresAt_idx',
      'DoctoraliaCatalogLease_connectionId_clinicId_key', 'DoctoraliaCatalogAttemptBucket_pkey'
    )
  )
), cols AS (
  SELECT r.relname AS table_name, a.attname AS column_name,
    pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
    NOT a.attnotnull AS nullable,
    a.attgenerated AS generated, a.attidentity AS identity,
    pg_catalog.pg_get_expr(d.adbin, d.adrelid) AS default_expr
  FROM relations r JOIN pg_catalog.pg_attribute a ON a.attrelid = r.oid
  LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = r.oid AND d.adnum = a.attnum
  WHERE a.attnum > 0 AND NOT a.attisdropped
), cons AS (
  SELECT r.relname AS table_name, con.conname, con.contype, con.convalidated,
    con.condeferrable, con.condeferred, con.confmatchtype,
    ARRAY(SELECT a.attname FROM unnest(con.conkey) WITH ORDINALITY k(attnum, ord)
      JOIN pg_catalog.pg_attribute a ON a.attrelid=con.conrelid AND a.attnum=k.attnum ORDER BY k.ord) AS columns,
    rr.relname AS ref_table, rn.nspname AS ref_schema,
    ARRAY(SELECT a.attname FROM unnest(con.confkey) WITH ORDINALITY k(attnum, ord)
      JOIN pg_catalog.pg_attribute a ON a.attrelid=con.confrelid AND a.attnum=k.attnum ORDER BY k.ord) AS ref_columns,
    con.confdeltype, con.confupdtype
  FROM relations r JOIN pg_catalog.pg_constraint con ON con.conrelid=r.oid
  LEFT JOIN pg_catalog.pg_class rr ON rr.oid=con.confrelid
  LEFT JOIN pg_catalog.pg_namespace rn ON rn.oid=rr.relnamespace
), idx AS (
  SELECT r.relname AS table_name, ic.relname AS index_name, i.indisunique, i.indisprimary,
    i.indisvalid, i.indisready, (to_jsonb(i)->>'indnullsnotdistinct') AS nulls_not_distinct, am.amname,
    ARRAY(SELECT a.attname FROM unnest(i.indkey::smallint[]) WITH ORDINALITY k(attnum, ord)
      JOIN pg_catalog.pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum
      WHERE k.ord <= i.indnkeyatts ORDER BY k.ord) AS columns,
    ARRAY(SELECT op.opcname FROM unnest(i.indclass::oid[]) WITH ORDINALITY k(opc_oid, ord)
      JOIN pg_catalog.pg_opclass op ON op.oid=k.opc_oid
      WHERE k.ord <= i.indnkeyatts ORDER BY k.ord) AS opclasses,
    ARRAY(SELECT option_value FROM unnest(i.indoption::smallint[]) WITH ORDINALITY k(option_value, ord)
      WHERE k.ord <= i.indnkeyatts ORDER BY k.ord) AS options,
    COALESCE((SELECT bool_and(k.collation_oid = a.attcollation)
      FROM unnest(i.indcollation::oid[]) WITH ORDINALITY k(collation_oid, ord)
      JOIN unnest(i.indkey::smallint[]) WITH ORDINALITY ik(attnum, ord) USING (ord)
      JOIN pg_catalog.pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=ik.attnum
      WHERE k.ord <= i.indnkeyatts), true) AS collations_match,
    i.indnkeyatts, i.indnatts, pg_catalog.pg_get_expr(i.indpred, i.indrelid) AS predicate,
    pg_catalog.pg_get_expr(i.indexprs, i.indrelid) AS expressions
  FROM relations r JOIN pg_catalog.pg_index i ON i.indrelid=r.oid
  JOIN pg_catalog.pg_class ic ON ic.oid=i.indexrelid
  JOIN pg_catalog.pg_am am ON am.oid=ic.relam
)
SELECT json_build_object(
  'tables', COALESCE((SELECT json_agg(json_build_object('name',relname,'kind',relkind,'relpersistence',relpersistence)) FROM relations), '[]'),
  'columns', COALESCE((SELECT json_agg(cols) FROM cols), '[]'),
  'constraints', COALESCE((SELECT json_agg(cons) FROM cons), '[]'),
  'indexes', COALESCE((SELECT json_agg(idx) FROM idx), '[]'),
  'reserved_constraints', COALESCE((
    SELECT json_agg(json_build_object('name', con.conname, 'table_name', c.relname))
    FROM pg_catalog.pg_constraint con
    JOIN pg_catalog.pg_class c ON c.oid=con.conrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=$1 AND con.conname IN (
      'DoctoraliaCatalogGeneration_pkey', 'DoctoraliaCatalogGeneration_clinicId_fkey',
      'DoctoraliaCatalogGeneration_connectionId_clinicId_fkey', 'DoctoraliaCatalogMember_pkey',
      'DoctoraliaCatalogMember_generationId_fkey', 'DoctoraliaCatalogMember_doctoraliaDoctorId_fkey',
      'DoctoraliaCatalogCredential_pkey', 'DoctoraliaCatalogCredential_memberId_fkey',
      'DoctoraliaCatalogLease_pkey', 'DoctoraliaCatalogLease_clinicId_fkey',
      'DoctoraliaCatalogLease_connectionId_clinicId_fkey', 'DoctoraliaCatalogAttemptBucket_pkey'
    )), '[]')
) AS snapshot`;

function schemaFromDatabaseUrl(value) {
  if (!value) throw new Error('missing_database_url');
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('invalid_database_url');
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error('invalid_database_url');
  }
  if (!parsed.hostname || !parsed.pathname || parsed.pathname === '/') {
    throw new Error('incomplete_database_url');
  }
  const schemas = parsed.searchParams.getAll('schema');
  if (schemas.length > 1 || (schemas.length === 1 && !schemas[0])) {
    throw new Error('invalid_target_schema');
  }
  const schema = schemas.length === 1 ? schemas[0] : 'public';
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(schema) || schema.length > 63) {
    throw new Error('invalid_target_schema');
  }
  return schema;
}

function normalizeDefault(value) {
  if (value == null) return null;
  const text = String(value).toLowerCase().replace(/\s+/g, '').replace(/::[\w\s"]+$/g, '');
  if (text === 'current_timestamp' || text === 'current_timestamp()' || text === 'now()') return 'now';
  return text.replace(/^\((.*)\)$/, '$1');
}

function sameArray(a, b) {
  return JSON.stringify(a || []) === JSON.stringify(b || []);
}

function inspectSnapshot(snapshot) {
  const issues = [];
  const tableRows = snapshot.tables || [];
  const columns = snapshot.columns || [];
  const constraints = snapshot.constraints || [];
  const indexes = snapshot.indexes || [];
  const reservedConstraints = snapshot.reserved_constraints || [];
  const table = (name) => tableRows.find((row) => row.name === name);
  const col = (name, column) => columns.find((row) => row.table_name === name && row.column_name === column);
  const con = (name, constraint) => constraints.find((row) => row.table_name === name && row.conname === constraint);
  const idx = (name, index) => indexes.find((row) => row.table_name === name && row.index_name === index);

  const baselineColumns = [
    ['Clinic', 'id'], ['IntegrationConnection', 'id'],
    ['IntegrationConnection', 'clinicId'], ['DoctoraliaDoctor', 'id'],
  ];
  for (const name of ['Clinic', 'IntegrationConnection', 'DoctoraliaDoctor']) {
    if (!table(name) || table(name).kind !== 'r' || table(name).relpersistence !== 'p') {
      issues.push(`baseline.table.${name}`);
    }
  }
  for (const [name, column] of baselineColumns) {
    const found = col(name, column);
    if (!found || found.data_type !== 'text' || found.nullable || found.generated || found.identity) {
      issues.push(`baseline.column.${name}.${column}`);
    }
  }
  for (const name of ['Clinic', 'IntegrationConnection', 'DoctoraliaDoctor']) {
    const primary = constraints.find((row) => row.table_name === name && row.contype === 'p');
    if (!primary || !primary.convalidated || primary.condeferrable || primary.condeferred ||
        !sameArray(primary.columns, ['id'])) issues.push(`baseline.primary_key.${name}`);
    const primaryIndex = indexes.find((row) => row.table_name === name && row.indisprimary);
    if (!primaryIndex || !primaryIndex.indisvalid || !primaryIndex.indisready ||
        !sameArray(primaryIndex.columns, ['id'])) issues.push(`baseline.primary_index.${name}`);
  }
  const clinicFk = constraints.find((row) =>
    row.table_name === 'IntegrationConnection' && row.contype === 'f' &&
    sameArray(row.columns, ['clinicId']));
  if (!clinicFk || !clinicFk.convalidated || clinicFk.ref_table !== 'Clinic' ||
      clinicFk.ref_schema !== snapshot.schema ||
      !sameArray(clinicFk.ref_columns, ['id']) ||
      clinicFk.confdeltype !== 'c' || clinicFk.confupdtype !== 'c' ||
      clinicFk.confmatchtype !== 's' || clinicFk.condeferrable || clinicFk.condeferred) {
    issues.push('baseline.foreign_key.IntegrationConnection.clinicId');
  }
  if (issues.length) return { state: 'baseline_incompatible', issues: issues.sort() };

  const targetPresent = Object.keys(TABLES).some((name) => Boolean(table(name))) ||
    Boolean(col('IntegrationConnection', 'catalogScopeVersion')) ||
    Boolean(idx('IntegrationConnection', 'IntegrationConnection_id_clinicId_key')) ||
    tableRows.some((row) => row.name.startsWith('DoctoraliaCatalog') ||
      row.name === 'IntegrationConnection_id_clinicId_key') ||
    reservedConstraints.length > 0;
  if (!targetPresent) return { state: 'absent', issues: [] };

  const targetIssues = [];
  const connectionColumn = col('IntegrationConnection', 'catalogScopeVersion');
  if (!connectionColumn || connectionColumn.data_type !== 'integer' || connectionColumn.nullable ||
      connectionColumn.generated || connectionColumn.identity ||
      normalizeDefault(connectionColumn.default_expr) !== '1') {
    targetIssues.push('target.column.IntegrationConnection.catalogScopeVersion');
  }
  checkIndex(idx('IntegrationConnection', 'IntegrationConnection_id_clinicId_key'),
    CONNECTION_INDEX, 'IntegrationConnection.IntegrationConnection_id_clinicId_key', targetIssues);

  for (const [name, definition] of Object.entries(TABLES)) {
    if (!table(name) || table(name).kind !== 'r' || table(name).relpersistence !== 'p') {
      targetIssues.push(`target.table.${name}`);
      continue;
    }
    const actualColumnNames = columns.filter((row) => row.table_name === name).map((row) => row.column_name).sort();
    if (!sameArray(actualColumnNames, Object.keys(definition.columns).sort())) {
      targetIssues.push(`target.columns.${name}`);
    }
    for (const [columnName, expected] of Object.entries(definition.columns)) {
      const found = col(name, columnName);
      if (!found || found.data_type !== expected[0] || found.nullable !== expected[1] ||
          found.generated || found.identity ||
          normalizeDefault(found.default_expr) !== expected[2]) {
        targetIssues.push(`target.column.${name}.${columnName}`);
      }
    }
    const actualConstraintNames = constraints.filter((row) => row.table_name === name).map((row) => row.conname).sort();
    if (!sameArray(actualConstraintNames, Object.keys(definition.constraints).sort())) {
      targetIssues.push(`target.constraints.${name}`);
    }
    for (const [constraintName, expected] of Object.entries(definition.constraints)) {
      const found = con(name, constraintName);
      if (!found || !found.convalidated || found.condeferrable || found.condeferred ||
          found.contype !== expected[0] ||
          !sameArray(found.columns, expected[1]) ||
          (expected[0] === 'f' && (found.ref_table !== expected[2] ||
            found.ref_schema !== snapshot.schema ||
            !sameArray(found.ref_columns, expected[3]) ||
            found.confdeltype !== expected[4] || found.confupdtype !== expected[5] ||
            found.confmatchtype !== 's'))) {
        targetIssues.push(`target.constraint.${name}.${constraintName}`);
      }
    }
    const actualIndexNames = indexes.filter((row) => row.table_name === name).map((row) => row.index_name).sort();
    if (!sameArray(actualIndexNames, Object.keys(definition.indexes).sort())) {
      targetIssues.push(`target.indexes.${name}`);
    }
    for (const [indexName, expected] of Object.entries(definition.indexes)) {
      checkIndex(idx(name, indexName), expected, `${name}.${indexName}`, targetIssues);
    }
  }
  for (const reserved of reservedConstraints) {
    const expectedOwner = Object.entries(TABLES).find(([, definition]) =>
      Object.prototype.hasOwnProperty.call(definition.constraints, reserved.name));
    if (!expectedOwner || expectedOwner[0] !== reserved.table_name) {
      targetIssues.push(`target.reserved_constraint.${reserved.name}`);
    }
  }
  return targetIssues.length
    ? { state: 'partial', issues: [...new Set(targetIssues)].sort() }
    : { state: 'applied', issues: [] };
}

function checkIndex(found, expected, label, issues) {
  const expectedOpclasses = expected[2].map((column) =>
    ['publishedAt', 'expiresAt', 'bucketStart'].includes(column) ? 'timestamp_ops' :
      column === 'catalogScopeVersion' ? 'int4_ops' : 'text_ops');
  if (!found || !found.indisvalid || !found.indisready || found.amname !== 'btree' ||
      found.indisunique !== expected[0] || found.indisprimary !== expected[1] ||
      found.nulls_not_distinct === 'true' ||
      !sameArray(found.columns, expected[2]) ||
      !sameArray(found.opclasses, expectedOpclasses) ||
      !sameArray(found.options, expected[2].map(() => 0)) ||
      found.collations_match !== true ||
      Number(found.indnkeyatts) !== expected[2].length ||
      Number(found.indnatts) !== expected[2].length ||
      found.predicate != null || found.expressions != null) {
    issues.push(`target.index.${label}`);
  }
}

async function readSnapshot(client, schema) {
  const result = await client.query(CATALOG_SQL, [schema]);
  return { ...result.rows[0].snapshot, schema };
}

async function runPreflight(client, schema) {
  await client.query('BEGIN READ ONLY');
  try {
    await client.query("SET LOCAL statement_timeout = '10s'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '15s'");
    const report = inspectSnapshot(await readSnapshot(client, schema));
    await client.query('COMMIT');
    return report;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  }
}

function quoteIdentifier(value) {
  return `"${value.replace(/"/g, '""')}"`;
}

async function runMigration(client, schema, authorization) {
  if (authorization !== 'true') throw new Error('migration_not_authorized');
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL lock_timeout = '10s'");
    await client.query("SET LOCAL statement_timeout = '60s'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '60s'");
    await client.query('SELECT pg_catalog.pg_advisory_xact_lock($1, $2)', [213, 261]);
    const before = inspectSnapshot(await readSnapshot(client, schema));
    if (before.state === 'applied') {
      await client.query('COMMIT');
      return { ...before, migrated: false };
    }
    if (before.state !== 'absent') {
      await client.query('ROLLBACK');
      return before;
    }
    await client.query(`SET LOCAL search_path TO ${quoteIdentifier(schema)}, pg_catalog`);
    await client.query(loadAuthorizedMigration());
    const after = inspectSnapshot(await readSnapshot(client, schema));
    if (after.state !== 'applied') throw new Error('post_migration_validation_failed');
    await client.query('COMMIT');
    return { ...after, migrated: true };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  }
}

function safeReport(report, output = console) {
  output.log(`[task261] schema state: ${report.state}`);
  for (const issue of report.issues || []) output.log(`[task261] ${issue}`);
  if (report.state === 'absent') {
    output.log('[task261] take and verify a database backup, then run migrate with APPLY_TASK261_MIGRATION=true.');
  } else if (report.state === 'partial') {
    output.log('[task261] no repair was attempted; stop and resolve the listed structural differences manually.');
  } else if (report.state === 'applied') {
    output.log(report.migrated
      ? '[task261] migration committed; remove APPLY_TASK261_MIGRATION from the environment before normal boot.'
      : '[task261] no DDL was required; remove APPLY_TASK261_MIGRATION from the environment before normal boot.');
  } else if (report.state === 'baseline_incompatible') {
    output.log('[task261] no repair was attempted; verify the historical baseline before this isolated migration.');
  }
}

async function main(argv = process.argv.slice(2), env = process.env, output = console) {
  const command = argv[0];
  if (argv.length !== 1 || !['preflight', 'migrate'].includes(command)) {
    output.error('[task261] configuration error: use "preflight" or "migrate"');
    return EXIT.config;
  }
  let schema;
  try {
    schema = schemaFromDatabaseUrl(env.DATABASE_URL);
    if (command === 'migrate' && env.APPLY_TASK261_MIGRATION !== 'true') {
      throw new Error('migration_not_authorized');
    }
  } catch {
    output.error('[task261] configuration error; DATABASE_URL is required and migration requires APPLY_TASK261_MIGRATION=true');
    return EXIT.config;
  }

  let client;
  try {
    client = new Client({ connectionString: env.DATABASE_URL, connectionTimeoutMillis: 10000 });
    await client.connect();
    const report = command === 'preflight'
      ? await runPreflight(client, schema)
      : await runMigration(client, schema, env.APPLY_TASK261_MIGRATION);
    safeReport(report, output);
    return EXIT[report.state];
  } catch {
    output.error('[task261] database operation failed; no connection details or server error are logged');
    return EXIT.runtime;
  } finally {
    if (client) {
      try { await client.end(); } catch {}
    }
  }
}

module.exports = {
  EXIT,
  TABLES,
  CONNECTION_INDEX,
  MIGRATION_PATH,
  MIGRATION_SHA256,
  MIGRATION_SQL,
  loadAuthorizedMigration,
  CATALOG_SQL,
  schemaFromDatabaseUrl,
  normalizeDefault,
  inspectSnapshot,
  readSnapshot,
  runPreflight,
  runMigration,
  safeReport,
  main,
};

if (require.main === module) {
  main().then((code) => {
    process.exitCode = code;
  });
}