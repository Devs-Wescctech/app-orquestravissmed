'use strict';

/*
 * Produces the exact Prisma datamodel immediately before Task 261 without
 * replaying migration history. It is intentionally dependency-free so both
 * local-PG integration tests and Docker smoke tests can use the same target:
 *
 * node apps/api/scripts/task261-tests/generate-prior-datamodel.js \
 *   --source apps/api/prisma/schema.prisma --output /tmp/pre-task261.prisma
 */
const fs = require('node:fs');
const path = require('node:path');

const taskModels = [
  'DoctoraliaCatalogGeneration',
  'DoctoraliaCatalogMember',
  'DoctoraliaCatalogCredential',
  'DoctoraliaCatalogLease',
  'DoctoraliaCatalogAttemptBucket',
];

function priorTask261Datamodel(schema) {
  let result = schema;
  for (const model of taskModels) {
    result = result.replace(
      new RegExp(`\\nmodel ${model} \\{[\\s\\S]*?\\n\\}\\n`, 'g'),
      '\n',
    );
  }

  for (const expression of [
    /^\s*doctoraliaCatalogGenerations DoctoraliaCatalogGeneration\[\]\s*$/gm,
    /^\s*doctoraliaCatalogLeases\s+DoctoraliaCatalogLease\[\]\s*$/gm,
    /^\s*catalogScopeVersion Int\s+@default\(1\)\s*$/gm,
    /^\s*doctoraliaCatalogLease\s+DoctoraliaCatalogLease\?\s*$/gm,
    /^\s*catalogMembers\s+DoctoraliaCatalogMember\[\]\s*$/gm,
    /^\s*@@unique\(\[id, clinicId\]\)\s*$/gm,
  ]) {
    result = result.replace(expression, '');
  }

  return result.replace(
    /\s*\/\/ Versão pública do escopo autorizado do catálogo\.[\s\S]*?\/\/ hashes\/segredos; muda somente quando identidade\/escopo é reautorizado\.\n/,
    '\n',
  );
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    if (!['--source', '--output'].includes(option) || !value) {
      throw new Error('usage: generate-prior-datamodel.js --source schema.prisma --output prior.prisma');
    }
    options[option.slice(2)] = value;
  }
  if (!options.source || !options.output) {
    throw new Error('usage: generate-prior-datamodel.js --source schema.prisma --output prior.prisma');
  }
  return options;
}

if (require.main === module) {
  const { source, output } = parseArguments(process.argv.slice(2));
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, priorTask261Datamodel(fs.readFileSync(source, 'utf8')));
}

module.exports = { priorTask261Datamodel };