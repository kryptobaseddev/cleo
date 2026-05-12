#!/usr/bin/env node
/**
 * Verifier for T9192 (PROTOCOL-HARDEN): Verifier-backed AC + auditor-loop.
 *
 * AC checks:
 *   1. `cleo verify --help` mentions '--acceptance-check' flag.
 *   2. `cleo verify --acceptance-check` with a verifier that exits 1 → cleo exits non-zero.
 *   3. `cleo audit --help` exists (exit 0).
 *   4. An ADR file exists titled 'Verifier-Backed AC' / 'Auditor Loop' or similar.
 *   5. The ct-orchestrator skill file contains an 'Auditor Loop' section.
 *
 * Exit 0 only if ALL checks pass.
 *
 * @task T9192
 * @see scripts/verify-t9192-fu.mjs
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

console.log('=== T9192 Verifier: Protocol-Harden — Verifier-Backed AC + Auditor Loop ===\n');

const failures = [];

function fail(msg) {
  console.error('FAIL:', msg);
  failures.push(msg);
}

function pass(msg) {
  console.log('PASS:', msg);
}

// ---------------------------------------------------------------------------
// Check 1: cleo verify --help mentions --acceptance-check
// ---------------------------------------------------------------------------

console.log('--- Check 1: cleo verify --help mentions --acceptance-check ---');

const CLEO_DIST = join(REPO_ROOT, 'packages', 'cleo', 'dist', 'cli', 'index.js');
const cleoCmd = existsSync(CLEO_DIST) ? ['node', CLEO_DIST] : ['cleo'];

const verifyHelp = spawnSync(cleoCmd[0], [...cleoCmd.slice(1), 'verify', '--help'], {
  encoding: 'utf8',
  cwd: REPO_ROOT,
});

if (verifyHelp.error) {
  fail(`Failed to run cleo verify --help: ${verifyHelp.error.message}`);
} else {
  const helpOutput = (verifyHelp.stdout || '') + (verifyHelp.stderr || '');
  if (!/acceptance.check/i.test(helpOutput)) {
    fail(
      `cleo verify --help does not mention '--acceptance-check'.\n` +
        `  Current output (first 500 chars): ${helpOutput.slice(0, 500)}\n\n` +
        `  T9192 AC requires cleo verify to support --acceptance-check flag that:\n` +
        `    - Resolves scripts/verify-<id>-fu.mjs (or scripts/verify-<id>.mjs)\n` +
        `    - Runs it via node\n` +
        `    - Returns non-zero if verifier exits non-zero\n` +
        `    - Blocks gate if non-zero`,
    );
  } else {
    pass(`cleo verify --help mentions --acceptance-check`);
  }
}

// ---------------------------------------------------------------------------
// Check 2: --acceptance-check actually blocks when verifier exits 1
// ---------------------------------------------------------------------------

console.log('\n--- Check 2: --acceptance-check blocks when verifier exits 1 ---');

// Create a temporary task + verifier that always exits 1
const tmpDir = mkdtempSync(join(tmpdir(), 'cleo-verify-t9192-'));
const fakeVerifierPath = join(tmpDir, 'verify-fake.mjs');
writeFileSync(
  fakeVerifierPath,
  `#!/usr/bin/env node
console.error('Fake verifier: always fails');
process.exit(1);
`,
);

try {
  // Run cleo verify with --acceptance-check pointing to our fake verifier
  const blockResult = spawnSync(
    cleoCmd[0],
    [...cleoCmd.slice(1), 'verify', 'T9192', '--acceptance-check', fakeVerifierPath],
    {
      encoding: 'utf8',
      cwd: REPO_ROOT,
    },
  );

  if (blockResult.status === 0) {
    fail(
      `cleo verify --acceptance-check returned exit 0 even though the verifier exited 1.\n` +
        `  The --acceptance-check flag MUST block (exit non-zero) when the verifier fails.\n` +
        `  stdout: ${(blockResult.stdout || '').slice(0, 300)}\n` +
        `  stderr: ${(blockResult.stderr || '').slice(0, 300)}`,
    );
  } else {
    pass(
      `cleo verify --acceptance-check correctly exits non-zero when verifier exits 1 (exit ${blockResult.status})`,
    );
  }
} catch (e) {
  // If the feature doesn't exist yet, spawnSync won't throw — check status
  fail(`Error running cleo verify --acceptance-check: ${e.message}`);
} finally {
  try {
    unlinkSync(fakeVerifierPath);
  } catch (_) {}
  try {
    import('node:fs').then((m) => m.rmdirSync(tmpDir));
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// Check 3: cleo audit --help exists
// ---------------------------------------------------------------------------

console.log('\n--- Check 3: cleo audit --help ---');

const auditHelp = spawnSync(cleoCmd[0], [...cleoCmd.slice(1), 'audit', '--help'], {
  encoding: 'utf8',
  cwd: REPO_ROOT,
});

if (auditHelp.error) {
  fail(`Failed to run cleo audit --help: ${auditHelp.error.message}`);
} else if (auditHelp.status !== 0) {
  // Check if it's the old cleo audit reconstruct (exists) vs new cleo audit <id>
  const helpOutput = (auditHelp.stdout || '') + (auditHelp.stderr || '');
  if (!/audit/i.test(helpOutput)) {
    fail(
      `cleo audit --help exited with status ${auditHelp.status}.\n` +
        `  T9192 AC requires 'cleo audit <taskId>' command that re-runs the verifier script.\n` +
        `  stdout: ${(auditHelp.stdout || '').slice(0, 300)}\n` +
        `  stderr: ${(auditHelp.stderr || '').slice(0, 300)}`,
    );
  } else {
    pass(`cleo audit --help exists (exit ${auditHelp.status}, has audit content)`);
  }
} else {
  const helpOutput = (auditHelp.stdout || '') + (auditHelp.stderr || '');
  // Must mention acceptance-check or verifier or independent
  if (!/verif|acceptance|script|independent/i.test(helpOutput)) {
    fail(
      `cleo audit --help exit 0 but does not mention verifier/acceptance/independent.\n` +
        `  T9192 requires 'cleo audit <id>' to describe re-running the verifier script.\n` +
        `  output: ${helpOutput.slice(0, 400)}`,
    );
  } else {
    pass(`cleo audit --help: exit 0, mentions verifier/acceptance context`);
  }
}

// ---------------------------------------------------------------------------
// Check 4: ADR file exists for Verifier-Backed AC
// ---------------------------------------------------------------------------

console.log('\n--- Check 4: ADR file for Verifier-Backed AC / Auditor Loop ---');

const ADR_DIRS = [join(REPO_ROOT, 'docs', 'adr'), join(REPO_ROOT, '.cleo', 'adrs')];

const ADR_CONTENT_PATTERNS = [/verifier.{0,20}backed/i, /auditor.{0,20}loop/i, /ADR-070/i];

let adrFound = false;
for (const adrDir of ADR_DIRS) {
  if (!existsSync(adrDir)) continue;
  const files = readdirSync(adrDir).filter((f) => f.endsWith('.md') || f.endsWith('.txt'));
  for (const file of files) {
    const content = readFileSync(join(adrDir, file), 'utf8');
    for (const pattern of ADR_CONTENT_PATTERNS) {
      if (pattern.test(content)) {
        adrFound = true;
        pass(`ADR found: ${join(adrDir, file)} matches pattern ${pattern}`);
        break;
      }
    }
    if (adrFound) break;
  }
  if (adrFound) break;
}

if (!adrFound) {
  fail(
    `No ADR file found for Verifier-Backed AC / Auditor Loop.\n` +
      `  Searched in: ${ADR_DIRS.join(', ')}\n` +
      `  Expected: docs/adr/ADR-070-verifier-backed-ac-auditor-loop.md\n` +
      `  The ADR must document:\n` +
      `    - The verifier-first pattern (AC measured by code, not claims)\n` +
      `    - The auditor-loop (separate Implementer + Auditor spawns)\n` +
      `    - Why: 2026-05-08 incident, scaffold-and-mark-done failure mode`,
  );
}

// ---------------------------------------------------------------------------
// Check 5: ct-orchestrator skill has Auditor Loop section
// ---------------------------------------------------------------------------

console.log('\n--- Check 5: ct-orchestrator skill has Auditor Loop section ---');

const SKILL_PATHS = [
  join(REPO_ROOT, '.claude', 'skills', 'ct-orchestrator', 'SKILL.md'),
  join(process.env.HOME || '/root', '.claude', 'skills', 'ct-orchestrator', 'SKILL.md'),
];

let skillFound = false;
for (const skillPath of SKILL_PATHS) {
  if (existsSync(skillPath)) {
    const content = readFileSync(skillPath, 'utf8');
    if (/auditor.{0,20}loop/i.test(content) || /auditor.{0,20}pattern/i.test(content)) {
      skillFound = true;
      pass(`ct-orchestrator skill at ${skillPath} contains Auditor Loop section`);
      break;
    } else {
      fail(
        `ct-orchestrator skill found at ${skillPath} but does NOT contain Auditor Loop section.\n` +
          `  T9192 requires the skill to document the pattern Leads MUST follow.\n` +
          `  Add an '## Auditor Loop' section documenting:\n` +
          `    Phase A: Write verifier first\n` +
          `    Phase B: Implementer spawn\n` +
          `    Phase C: Auditor spawn (independent)\n` +
          `    Phase D: Loop until pass (max 4 iterations)`,
      );
    }
  }
}

if (!skillFound && failures.filter((f) => f.includes('ct-orchestrator')).length === 0) {
  fail(
    `ct-orchestrator skill not found at any expected path.\n` +
      `  Searched: ${SKILL_PATHS.join(', ')}\n` +
      `  T9192 requires the skill file to document the Auditor Loop pattern.`,
  );
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log('\n--- Summary ---');
if (failures.length > 0) {
  console.error(`\nFAILED: ${failures.length} check(s) failed:`);
  for (const f of failures) {
    console.error(`  - ${f}`);
  }
  process.exit(1);
} else {
  console.log('\nALL CHECKS PASSED. T9192 AC satisfied.');
  process.exit(0);
}
