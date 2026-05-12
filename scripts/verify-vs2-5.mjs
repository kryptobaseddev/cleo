#!/usr/bin/env node
/**
 * Verifier for T9226: VS2-5 worktree weight — spawn-clone-exclude filter.
 *
 * AC:
 *   1. SPAWN_CLONE_EXCLUDE_PATTERNS is exported from spawn-prompt.ts and includes
 *      'scripts/verify-*.mjs' and '.gitnexus'.
 *   2. BuildSpawnPromptInput has a spawnCloneExclude?: readonly string[] field.
 *   3. ComposeSpawnPayloadOptions has a spawnCloneExclude?: readonly string[] field.
 *   4. CreateWorktreeOptions has spawnCloneExclude and spawnCloneExcludeExempt fields.
 *   5. worktree-create.ts applies the exclude filter via applySpawnCloneExcludeFilter.
 *   6. buildSpawnCloneExcludeBlock is used by buildSpawnPrompt when spawnCloneExclude is set.
 *   7. orchestrateSpawn passes SPAWN_CLONE_EXCLUDE_PATTERNS to spawnWorktree with task-scoped exempt.
 */
import { readFileSync } from 'node:fs';
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

function readSrc(rel) {
  return readFileSync(join(REPO_ROOT, rel), 'utf8');
}

// ---------------------------------------------------------------------------
// Check 1: SPAWN_CLONE_EXCLUDE_PATTERNS exported from spawn-prompt.ts
// ---------------------------------------------------------------------------
const spawnPromptSrc = readSrc('packages/core/src/orchestration/spawn-prompt.ts');

if (spawnPromptSrc.includes('SPAWN_CLONE_EXCLUDE_PATTERNS')) {
  pass('spawn-prompt.ts exports SPAWN_CLONE_EXCLUDE_PATTERNS');
} else {
  fail('spawn-prompt.ts must export SPAWN_CLONE_EXCLUDE_PATTERNS constant (T9226)');
}

if (spawnPromptSrc.includes("'scripts/verify-*.mjs'")) {
  pass("SPAWN_CLONE_EXCLUDE_PATTERNS includes 'scripts/verify-*.mjs'");
} else {
  fail("SPAWN_CLONE_EXCLUDE_PATTERNS must include 'scripts/verify-*.mjs' pattern (T9226)");
}

if (spawnPromptSrc.includes("'.gitnexus'")) {
  pass("SPAWN_CLONE_EXCLUDE_PATTERNS includes '.gitnexus'");
} else {
  fail("SPAWN_CLONE_EXCLUDE_PATTERNS must include '.gitnexus' pattern (T9226)");
}

// ---------------------------------------------------------------------------
// Check 2: BuildSpawnPromptInput has spawnCloneExclude field
// ---------------------------------------------------------------------------
if (spawnPromptSrc.includes('spawnCloneExclude')) {
  pass('BuildSpawnPromptInput has spawnCloneExclude field');
} else {
  fail('BuildSpawnPromptInput must have spawnCloneExclude?: readonly string[] field (T9226)');
}

if (spawnPromptSrc.includes('buildSpawnCloneExcludeBlock')) {
  pass('spawn-prompt.ts defines buildSpawnCloneExcludeBlock function');
} else {
  fail('spawn-prompt.ts must define buildSpawnCloneExcludeBlock function (T9226)');
}

if (spawnPromptSrc.includes('Worktree Scope (spawn-clone-exclude')) {
  pass('buildSpawnCloneExcludeBlock emits correct section header');
} else {
  fail(
    'buildSpawnCloneExcludeBlock must emit ## Worktree Scope (spawn-clone-exclude) section (T9226)',
  );
}

// ---------------------------------------------------------------------------
// Check 3: ComposeSpawnPayloadOptions has spawnCloneExclude field
// ---------------------------------------------------------------------------
const spawnSrc = readSrc('packages/core/src/orchestration/spawn.ts');

if (spawnSrc.includes('spawnCloneExclude')) {
  pass('ComposeSpawnPayloadOptions has spawnCloneExclude field in spawn.ts');
} else {
  fail('spawn.ts ComposeSpawnPayloadOptions must have spawnCloneExclude field (T9226)');
}

// ---------------------------------------------------------------------------
// Check 4: CreateWorktreeOptions has spawnCloneExclude and spawnCloneExcludeExempt
// ---------------------------------------------------------------------------
const worktreeContractSrc = readSrc('packages/contracts/src/operations/worktree.ts');

if (worktreeContractSrc.includes('spawnCloneExclude')) {
  pass('CreateWorktreeOptions has spawnCloneExclude field in contracts');
} else {
  fail(
    'contracts/operations/worktree.ts CreateWorktreeOptions must have spawnCloneExclude field (T9226)',
  );
}

if (worktreeContractSrc.includes('spawnCloneExcludeExempt')) {
  pass('CreateWorktreeOptions has spawnCloneExcludeExempt field in contracts');
} else {
  fail(
    'contracts/operations/worktree.ts CreateWorktreeOptions must have spawnCloneExcludeExempt field (T9226)',
  );
}

// ---------------------------------------------------------------------------
// Check 5: worktree-create.ts applies the exclude filter
// ---------------------------------------------------------------------------
const worktreeCreateSrc = readSrc('packages/worktree/src/worktree-create.ts');

if (worktreeCreateSrc.includes('applySpawnCloneExcludeFilter')) {
  pass('worktree-create.ts defines and calls applySpawnCloneExcludeFilter');
} else {
  fail('worktree-create.ts must define and call applySpawnCloneExcludeFilter function (T9226)');
}

if (worktreeCreateSrc.includes('sparse-checkout')) {
  pass('worktree-create.ts uses sparse-checkout to exclude patterns');
} else {
  fail('worktree-create.ts must use git sparse-checkout to apply exclude filter (T9226)');
}

if (
  worktreeCreateSrc.includes('spawnCloneExclude') &&
  worktreeCreateSrc.includes('spawnCloneExcludeExempt')
) {
  pass('worktree-create.ts reads spawnCloneExclude and spawnCloneExcludeExempt from options');
} else {
  fail(
    'worktree-create.ts must read both spawnCloneExclude and spawnCloneExcludeExempt from CreateWorktreeOptions (T9226)',
  );
}

if (worktreeCreateSrc.includes('appliedExcludePatterns')) {
  pass('worktree-create.ts returns appliedExcludePatterns in result');
} else {
  fail('worktree-create.ts must return appliedExcludePatterns in the result (T9226)');
}

// ---------------------------------------------------------------------------
// Check 6: orchestrate/spawn-ops.ts passes SPAWN_CLONE_EXCLUDE_PATTERNS
// ---------------------------------------------------------------------------
const spawnOpsSrc = readSrc('packages/core/src/orchestrate/spawn-ops.ts');

if (spawnOpsSrc.includes('SPAWN_CLONE_EXCLUDE_PATTERNS')) {
  pass('spawn-ops.ts references SPAWN_CLONE_EXCLUDE_PATTERNS for worktree provisioning');
} else {
  fail('spawn-ops.ts must pass SPAWN_CLONE_EXCLUDE_PATTERNS to spawnWorktree (T9226)');
}

if (spawnOpsSrc.includes('spawnCloneExcludeExempt')) {
  pass('spawn-ops.ts passes task-scoped spawnCloneExcludeExempt to preserve own verifier');
} else {
  fail("spawn-ops.ts must pass spawnCloneExcludeExempt with task's own verifier path (T9226)");
}

if (spawnOpsSrc.includes('appliedWorktreeExcludePatterns')) {
  pass('spawn-ops.ts captures and threads appliedWorktreeExcludePatterns to spawn prompt');
} else {
  fail(
    'spawn-ops.ts must capture appliedWorktreeExcludePatterns from worktree result and pass to composeSpawnForTask (T9226)',
  );
}

// ---------------------------------------------------------------------------
// Final
// ---------------------------------------------------------------------------
if (failures.length === 0) {
  console.log('\nVERIFIER PASS: T9226 — VS2-5 worktree weight: spawn-clone-exclude filter');
  process.exit(0);
} else {
  console.error(`\nVERIFIER FAIL: ${failures.length} check(s) failed`);
  process.exit(1);
}
