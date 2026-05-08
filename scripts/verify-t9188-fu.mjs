#!/usr/bin/env node
/**
 * Verifier for T9188 (T9050-FU): Wire 6 sub-accessors in UmbrellaDataAccessor.
 *
 * AC checks:
 *   1. @cleocode/contracts exports BrainAccessor, ConduitAccessor, NexusAccessor,
 *      SignaldockAccessor, TelemetryAccessor, DocsAccessor.
 *   2. UmbrellaDataAccessor.getSubAccessor does NOT throw for each of the 6 roles.
 *   3. Each returned object is non-null.
 *   4. For 'brain' specifically: a minimal round-trip (observe + find) succeeds.
 *
 * Exit 0 only if ALL checks pass.
 *
 * @task T9188
 * @see scripts/verify-t9188-fu.mjs
 */

import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

let failures = [];

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function fail(msg) {
  console.error('FAIL:', msg);
  failures.push(msg);
}

function pass(msg) {
  console.log('PASS:', msg);
}

// ---------------------------------------------------------------------------
// Check 1: @cleocode/contracts exports the 6 sub-accessor interfaces
// ---------------------------------------------------------------------------

const REQUIRED_EXPORTS = [
  'BrainAccessor',
  'ConduitAccessor',
  'NexusAccessor',
  'SignaldockAccessor',
  'TelemetryAccessor',
  'DocsAccessor',
];

async function checkContractsExports() {
  console.log('\n--- Check 1: @cleocode/contracts sub-accessor exports ---');
  let contractsMod;
  try {
    contractsMod = await import(join(REPO_ROOT, 'packages/contracts/src/index.js'));
  } catch (e) {
    // Try compiled dist
    try {
      contractsMod = await import('@cleocode/contracts');
    } catch (e2) {
      fail(`Cannot import @cleocode/contracts: ${e2.message}`);
      return;
    }
  }

  const missing = [];
  for (const name of REQUIRED_EXPORTS) {
    if (!(name in contractsMod)) {
      missing.push(name);
    }
  }
  if (missing.length > 0) {
    fail(`Missing exports from @cleocode/contracts: ${missing.join(', ')}`);
  } else {
    pass(`All 6 sub-accessor types exported from @cleocode/contracts: ${REQUIRED_EXPORTS.join(', ')}`);
  }
}

// ---------------------------------------------------------------------------
// Check 2: UmbrellaDataAccessor.getSubAccessor does not throw for 6 roles
// ---------------------------------------------------------------------------

const SUB_ACCESSOR_ROLES = ['brain', 'conduit', 'nexus', 'signaldock', 'telemetry', 'docs'];

async function checkSubAccessors() {
  console.log('\n--- Check 2: UmbrellaDataAccessor.getSubAccessor for 6 roles ---');

  let UmbrellaDataAccessor;
  try {
    const coreMod = await import(
      join(REPO_ROOT, 'packages/core/dist/store/umbrella-data-accessor.js')
    );
    UmbrellaDataAccessor = coreMod.UmbrellaDataAccessor;
  } catch (e) {
    fail(`Cannot import UmbrellaDataAccessor: ${e.message}`);
    return;
  }

  const umbrella = new UmbrellaDataAccessor(REPO_ROOT);

  for (const role of SUB_ACCESSOR_ROLES) {
    try {
      const accessor = await umbrella.getSubAccessor(role);
      if (accessor == null) {
        fail(`getSubAccessor('${role}') returned null/undefined`);
      } else {
        pass(`getSubAccessor('${role}') returned non-null accessor`);
      }
    } catch (e) {
      fail(`getSubAccessor('${role}') threw: ${e.message}`);
    }
  }

  try {
    await umbrella.close();
  } catch (_) {
    // ignore close errors
  }
}

// ---------------------------------------------------------------------------
// Check 3: Brain round-trip (observe + find)
// ---------------------------------------------------------------------------

async function checkBrainRoundTrip() {
  console.log('\n--- Check 3: Brain sub-accessor round-trip ---');

  let UmbrellaDataAccessor;
  try {
    const coreMod = await import(
      join(REPO_ROOT, 'packages/core/dist/store/umbrella-data-accessor.js')
    );
    UmbrellaDataAccessor = coreMod.UmbrellaDataAccessor;
  } catch (e) {
    fail(`Cannot import UmbrellaDataAccessor for brain round-trip: ${e.message}`);
    return;
  }

  const umbrella = new UmbrellaDataAccessor(REPO_ROOT);

  try {
    const brainAccessor = await umbrella.getSubAccessor('brain');

    // Try observe
    if (typeof brainAccessor.observe !== 'function') {
      fail(`BrainAccessor missing 'observe' method`);
    } else {
      await brainAccessor.observe('verify-t9188-probe', {
        title: 'T9188 verifier probe',
        type: 'observation',
      });
      pass(`BrainAccessor.observe() succeeded`);
    }

    // Try find
    if (typeof brainAccessor.find !== 'function') {
      fail(`BrainAccessor missing 'find' method`);
    } else {
      const results = await brainAccessor.find('verify-t9188-probe');
      if (!Array.isArray(results)) {
        fail(`BrainAccessor.find() did not return an array`);
      } else {
        pass(`BrainAccessor.find() returned array (${results.length} results)`);
      }
    }
  } catch (e) {
    fail(`Brain round-trip threw: ${e.message}`);
  } finally {
    try {
      await umbrella.close();
    } catch (_) {
      // ignore
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('=== T9188 Verifier: Wire 6 sub-accessors in UmbrellaDataAccessor ===\n');

  await checkContractsExports();
  await checkSubAccessors();
  await checkBrainRoundTrip();

  console.log('\n--- Summary ---');
  if (failures.length > 0) {
    console.error(`\nFAILED: ${failures.length} check(s) failed:`);
    for (const f of failures) {
      console.error(`  - ${f}`);
    }
    process.exit(1);
  } else {
    console.log('\nALL CHECKS PASSED. T9188 AC satisfied.');
    process.exit(0);
  }
}

main().catch((e) => {
  console.error('Verifier crashed:', e);
  process.exit(1);
});
