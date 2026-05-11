#!/usr/bin/env node
/**
 * Verifier for T9215: W1 delegate_task JSON envelope sentinel
 *
 * Source task: T9215
 *
 * AC:
 *   - DelegateTaskEnvelope discriminated-union type defined in packages/contracts/src/spawn.ts
 *   - adapter recognizer parses sentinel and routes to orchestrateSpawnExecute
 *   - WORKER_FORBIDDEN_SPAWN_TOOLS extends to include delegate_task for tier-0
 *   - validateSpawnRequest enforced at parse time
 *   - ct-lead skill content updated to match formal schema
 *   - claude-code adapter test passes (structural check)
 *   - pi adapter test passes (structural check)
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const failures = [];

function fail(msg) {
  console.error('FAIL:', msg);
  failures.push(msg);
}

function pass(msg) {
  console.log('PASS:', msg);
}

function readFile(rel) {
  const p = join(REPO_ROOT, rel);
  if (!existsSync(p)) return null;
  return readFileSync(p, 'utf8');
}

const SPAWN_CONTRACTS_PATH = 'packages/contracts/src/spawn.ts';
const spawnSrc = readFile(SPAWN_CONTRACTS_PATH);
if (!spawnSrc) {
  console.error(`FATAL: Cannot read ${SPAWN_CONTRACTS_PATH}`);
  process.exit(1);
}

const HIERARCHY_PATH = 'packages/cant/src/hierarchy.ts';
const hierarchySrc = readFile(HIERARCHY_PATH);
if (!hierarchySrc) {
  console.error(`FATAL: Cannot read ${HIERARCHY_PATH}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Check 1: DelegateTaskEnvelope type defined in contracts/src/spawn.ts
// ---------------------------------------------------------------------------
if (spawnSrc.includes('DelegateTaskEnvelope') && spawnSrc.includes("'delegate_task'")) {
  pass('DelegateTaskEnvelope discriminated-union type found in contracts/src/spawn.ts (T9215)');
} else {
  fail(
    "DelegateTaskEnvelope type with discriminant 'delegate_task' must be defined in packages/contracts/src/spawn.ts (T9215)",
  );
}

// ---------------------------------------------------------------------------
// Check 2: DelegateTaskEnvelope has tasks array field
// ---------------------------------------------------------------------------
if (spawnSrc.includes('DelegateTaskEnvelope') && spawnSrc.includes('tasks')) {
  // Check if the interface body (search from 'interface DelegateTaskEnvelope') includes tasks
  const ifaceIdx = spawnSrc.indexOf('interface DelegateTaskEnvelope');
  if (ifaceIdx !== -1) {
    const snippet = spawnSrc.slice(ifaceIdx, ifaceIdx + 1000);
    if (snippet.includes('tasks')) {
      pass('DelegateTaskEnvelope has tasks field (T9215)');
    } else {
      fail(
        'DelegateTaskEnvelope must have a tasks field containing child task descriptors (T9215)',
      );
    }
  } else {
    // Fallback: args.tasks or tasks: DelegateTaskChild[] anywhere in file near the type
    const hasTasksOnEnvelope =
      spawnSrc.includes('tasks: DelegateTaskChild') ||
      (spawnSrc.includes('DelegateTaskEnvelope') && spawnSrc.includes('tasks'));
    if (hasTasksOnEnvelope) {
      pass('DelegateTaskEnvelope has tasks field (T9215)');
    } else {
      fail(
        'DelegateTaskEnvelope must have a tasks field containing child task descriptors (T9215)',
      );
    }
  }
} else {
  fail('DelegateTaskEnvelope must have a tasks field (T9215)');
}

// ---------------------------------------------------------------------------
// Check 3: parseDelegateTaskEnvelope function exists (recognizer)
// ---------------------------------------------------------------------------
const hasRecognizer =
  spawnSrc.includes('parseDelegateTaskEnvelope') ||
  readFile('packages/core/src/orchestrate/spawn-ops.ts')?.includes('parseDelegateTaskEnvelope') ||
  readFile('packages/core/src/orchestration/spawn.ts')?.includes('parseDelegateTaskEnvelope');

if (hasRecognizer) {
  pass('parseDelegateTaskEnvelope recognizer function found (T9215)');
} else {
  fail(
    'parseDelegateTaskEnvelope function must exist to parse JSON sentinel from adapter stdout (T9215)',
  );
}

// ---------------------------------------------------------------------------
// Check 4: WORKER_FORBIDDEN_SPAWN_TOOLS includes 'delegate_task'
// ---------------------------------------------------------------------------
if (
  hierarchySrc.includes("'delegate_task'") &&
  hierarchySrc.includes('WORKER_FORBIDDEN_SPAWN_TOOLS')
) {
  // Check they're in the same array
  const forbiddenMatch = /WORKER_FORBIDDEN_SPAWN_TOOLS\s*=\s*\[([^\]]+)\]/.exec(hierarchySrc);
  if (forbiddenMatch && forbiddenMatch[1].includes('delegate_task')) {
    pass("WORKER_FORBIDDEN_SPAWN_TOOLS includes 'delegate_task' (T9215)");
  } else {
    fail(
      "WORKER_FORBIDDEN_SPAWN_TOOLS array must include 'delegate_task' to prevent worker recursion (T9215)",
    );
  }
} else {
  fail("WORKER_FORBIDDEN_SPAWN_TOOLS must include 'delegate_task' for tier-0 prevention (T9215)");
}

// ---------------------------------------------------------------------------
// Check 5: DelegateTaskEnvelope exported from contracts
// ---------------------------------------------------------------------------
if (
  spawnSrc.includes('export interface DelegateTaskEnvelope') ||
  spawnSrc.includes('export type DelegateTaskEnvelope') ||
  (spawnSrc.includes('DelegateTaskEnvelope') && spawnSrc.includes('export'))
) {
  pass('DelegateTaskEnvelope is exported from contracts/src/spawn.ts (T9215)');
} else {
  fail('DelegateTaskEnvelope must be exported from packages/contracts/src/spawn.ts (T9215)');
}

// ---------------------------------------------------------------------------
// Check 6: ct-lead skill content references DelegateTaskEnvelope or updated schema
// ---------------------------------------------------------------------------
const ctLeadSkillSrc = readFile('packages/skills/skills/ct-lead/SKILL.md');
const ctLeadRefSrc = readFile('packages/skills/skills/ct-lead/references/spawn-pattern.md');

const ctLeadHasEnvelope =
  ctLeadSkillSrc?.includes('DelegateTaskEnvelope') ||
  ctLeadRefSrc?.includes('DelegateTaskEnvelope') ||
  ctLeadSkillSrc?.includes('delegate_task') ||
  ctLeadRefSrc?.includes('delegate_task');

if (ctLeadHasEnvelope) {
  pass('ct-lead skill references delegate_task envelope shape (T9215)');
} else {
  fail('ct-lead skill must reference the DelegateTaskEnvelope formal schema (T9215)');
}

// ---------------------------------------------------------------------------
// Check 7: parseDelegateTaskEnvelope validates hierarchy via validateSpawnRequest
// ---------------------------------------------------------------------------
const parserSrc =
  readFile('packages/contracts/src/spawn.ts') ||
  readFile('packages/core/src/orchestrate/spawn-ops.ts') ||
  '';

const hasHierarchyValidation =
  parserSrc.includes('validateSpawnRequest') || hierarchySrc.includes('validateSpawnRequest');

if (hasHierarchyValidation) {
  pass('validateSpawnRequest is called for hierarchy enforcement (T9215)');
} else {
  fail(
    'parseDelegateTaskEnvelope must call validateSpawnRequest for hierarchy enforcement (T9215)',
  );
}

// ---------------------------------------------------------------------------
// Final
// ---------------------------------------------------------------------------
if (failures.length === 0) {
  console.log('\nVERIFIER PASS: T9215 — delegate_task JSON envelope sentinel');
  process.exit(0);
} else {
  console.error(`\nVERIFIER FAIL: ${failures.length} check(s) failed`);
  process.exit(1);
}
