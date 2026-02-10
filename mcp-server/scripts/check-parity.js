#!/usr/bin/env node

import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const queryPath = path.join(ROOT, 'src/gateways/query.ts');
const mutatePath = path.join(ROOT, 'src/gateways/mutate.ts');
const schemaPath = path.join(ROOT, 'schemas/index.json');

const EXPECTED_QUERY = 56;
const EXPECTED_MUTATE = 51;
const EXPECTED_TOTAL = 107;

const EXPECTED_EXTENSIONS = new Set([
  'query:tasks.relates',
  'query:system.job.status',
  'query:system.job.list',
  'query:system.dash',
  'query:system.roadmap',
  'query:system.labels',
  'query:system.compliance',
  'query:system.log',
  'query:system.archive-stats',
  'query:system.sequence',
  'mutate:tasks.relates.add',
  'mutate:system.job.cancel',
  'mutate:system.safestop',
  'mutate:system.uncancel',
]);

function fail(message) {
  console.error(`PARITY FAIL: ${message}`);
  process.exitCode = 1;
}

function parseOperationMatrix(filePath, constName) {
  const content = fs.readFileSync(filePath, 'utf8');
  const matrixMatch = content.match(new RegExp(`export const ${constName}:[\\s\\S]*?=\\s*\\{([\\s\\S]*?)\\n\\};`));
  if (!matrixMatch) {
    throw new Error(`Could not parse ${constName} from ${filePath}`);
  }

  const domainBody = matrixMatch[1];
  const domainRegex = /\s*([a-z]+):\s*\[([\s\S]*?)\],/g;
  const out = {};
  let dm;

  while ((dm = domainRegex.exec(domainBody))) {
    const domain = dm[1];
    const ops = [];
    const opRegex = /'([^']+)'\s*,/g;
    let om;
    while ((om = opRegex.exec(dm[2]))) {
      ops.push(om[1]);
    }
    out[domain] = ops;
  }

  return out;
}

function flatten(kind, matrix) {
  const out = [];
  for (const [domain, ops] of Object.entries(matrix)) {
    for (const op of ops) out.push(`${kind}:${domain}.${op}`);
  }
  return out;
}

function main() {
  const query = parseOperationMatrix(queryPath, 'QUERY_OPERATIONS');
  const mutate = parseOperationMatrix(mutatePath, 'MUTATE_OPERATIONS');
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));

  const queryOps = flatten('query', query);
  const mutateOps = flatten('mutate', mutate);
  const allGateway = [...queryOps, ...mutateOps];

  if (queryOps.length !== EXPECTED_QUERY) {
    fail(`query count mismatch: expected ${EXPECTED_QUERY}, got ${queryOps.length}`);
  }
  if (mutateOps.length !== EXPECTED_MUTATE) {
    fail(`mutate count mismatch: expected ${EXPECTED_MUTATE}, got ${mutateOps.length}`);
  }
  if (allGateway.length !== EXPECTED_TOTAL) {
    fail(`total count mismatch: expected ${EXPECTED_TOTAL}, got ${allGateway.length}`);
  }

  const schemaOps = [];
  for (const [domain, spec] of Object.entries(schema.domains)) {
    for (const op of spec.queries || []) schemaOps.push(`query:${domain}.${op}`);
    for (const op of spec.mutations || []) schemaOps.push(`mutate:${domain}.${op}`);
  }

  const setGateway = new Set(allGateway);
  const setSchema = new Set(schemaOps);

  const schemaMissingInGateway = [...setSchema].filter((op) => !setGateway.has(op));
  if (schemaMissingInGateway.length > 0) {
    fail(`schema operations missing in gateway: ${schemaMissingInGateway.join(', ')}`);
  }

  const gatewayExtensions = new Set([...setGateway].filter((op) => !setSchema.has(op)));
  for (const op of EXPECTED_EXTENSIONS) {
    if (!gatewayExtensions.has(op)) {
      fail(`expected extension missing: ${op}`);
    }
  }
  for (const op of gatewayExtensions) {
    if (!EXPECTED_EXTENSIONS.has(op)) {
      fail(`unexpected extension operation: ${op}`);
    }
  }

  if (process.exitCode && process.exitCode !== 0) {
    return;
  }

  console.log('PARITY OK');
  console.log(`- query operations: ${queryOps.length}`);
  console.log(`- mutate operations: ${mutateOps.length}`);
  console.log(`- total operations: ${allGateway.length}`);
  console.log(`- schema baseline operations: ${schemaOps.length}`);
  console.log(`- extensions: ${gatewayExtensions.size}`);
}

main();
