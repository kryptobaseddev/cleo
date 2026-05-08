#!/usr/bin/env node
/**
 * Verifier for T1875: Add decision evidence atom kind ('decision:<id>') to gate verify system.
 *
 * This script is the acceptance criterion for T1875. It MUST exit non-zero
 * before the implementation lands. It MUST exit 0 after.
 *
 * Checks:
 * 1. EvidenceAtom type in @cleocode/contracts has a 'decision' variant
 * 2. parseEvidence in @cleocode/core accepts 'decision:<id>' syntax
 * 3. Fake decision ID is rejected with E_EVIDENCE_INVALID_DECISION (or similar error)
 * 4. GATE_EVIDENCE_MINIMUMS allows 'decision' atom for 'implemented' gate
 *    (decision + files satisfies the gate)
 * 5. CLEO-INJECTION.md updated with decision: evidence atom example
 * 6. Tests exist covering the decision atom path
 *
 * @task T1875
 * @epic T1824
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

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

// ---------------------------------------------------------------------------
// Check 1: EvidenceAtom type has 'decision' variant in contracts
// ---------------------------------------------------------------------------
function checkContractsType() {
  console.log('\n--- Check 1: EvidenceAtom type includes decision variant ---');

  const taskTs = join(REPO_ROOT, 'packages', 'contracts', 'src', 'task.ts');
  if (!existsSync(taskTs)) {
    fail(`packages/contracts/src/task.ts not found`);
    return;
  }

  const content = readFileSync(taskTs, 'utf8');

  // Look for decision variant in EvidenceAtom union
  if (!content.includes("kind: 'decision'") && !content.includes('kind: "decision"')) {
    fail(
      `EvidenceAtom type in packages/contracts/src/task.ts does not have a 'decision' variant. ` +
      `Expected: { kind: 'decision'; decisionId: string } or similar in the EvidenceAtom union.`,
    );
  } else {
    pass(`EvidenceAtom type includes 'decision' variant in packages/contracts/src/task.ts`);
  }

  // Check it carries a decisionId field (or similar)
  const hasDecisionId =
    content.includes('decisionId') || content.includes('decision_id') || content.includes('id:');
  if (!hasDecisionId) {
    fail(
      `EvidenceAtom 'decision' variant should carry a decision identifier field (decisionId).`,
    );
  }

  // Check .d.ts dist
  const distDts = join(REPO_ROOT, 'packages', 'contracts', 'dist', 'task.d.ts');
  if (existsSync(distDts)) {
    const distContent = readFileSync(distDts, 'utf8');
    if (!distContent.includes("kind: 'decision'") && !distContent.includes('kind: "decision"')) {
      fail(
        `packages/contracts/dist/task.d.ts (compiled output) does not include 'decision' variant. ` +
        `Run 'pnpm run build' to regenerate.`,
      );
    } else {
      pass(`Compiled contracts dist/task.d.ts includes 'decision' variant`);
    }
  }
}

// ---------------------------------------------------------------------------
// Check 2: parseEvidence accepts 'decision:<id>' atom
// ---------------------------------------------------------------------------
async function checkParseEvidence() {
  console.log('\n--- Check 2: parseEvidence accepts decision:<id> atoms ---');

  const evidenceTs = join(REPO_ROOT, 'packages', 'core', 'src', 'tasks', 'evidence.ts');
  if (!existsSync(evidenceTs)) {
    fail(`packages/core/src/tasks/evidence.ts not found`);
    return;
  }

  const source = readFileSync(evidenceTs, 'utf8');

  // Check for decision case in the switch
  if (!source.includes("case 'decision':") && !source.includes('case "decision":')) {
    fail(
      `parseEvidence in packages/core/src/tasks/evidence.ts does not handle 'decision:' atom kind. ` +
      `Add a 'case "decision"' branch to the switch statement.`,
    );
  } else {
    pass(`parseEvidence handles 'decision:' case`);
  }

  // Check ParsedAtom union has decision variant
  if (
    !source.includes("kind: 'decision'") &&
    !source.includes("kind: \"decision\"")
  ) {
    fail(
      `ParsedAtom union in packages/core/src/tasks/evidence.ts does not include 'decision' variant.`,
    );
  } else {
    pass(`ParsedAtom union includes 'decision' variant`);
  }

  // Try importing the built module and parsing a decision atom
  const evidenceJsPath = join(
    REPO_ROOT,
    'packages',
    'core',
    'dist',
    'tasks',
    'evidence.js',
  );
  if (!existsSync(evidenceJsPath)) {
    fail(
      `packages/core/dist/tasks/evidence.js not found — run 'pnpm run build' first`,
    );
    return;
  }

  try {
    const mod = await import(evidenceJsPath);
    const parseEvidence = mod.parseEvidence;
    if (typeof parseEvidence !== 'function') {
      fail(`parseEvidence is not exported from the built module`);
      return;
    }

    // Valid parse — should not throw
    let parsed;
    try {
      parsed = parseEvidence('decision:D-001');
      if (!parsed?.atoms?.some((a) => a.kind === 'decision')) {
        fail(`parseEvidence('decision:D-001') did not produce a decision atom`);
      } else {
        pass(`parseEvidence('decision:D-001') produced decision atom correctly`);
      }
    } catch (e) {
      fail(`parseEvidence('decision:D-001') threw unexpectedly: ${e.message}`);
    }

    // Invalid parse — unknown kind should still throw
    let threw = false;
    try {
      parseEvidence('bogus-kind-xyz:payload');
    } catch {
      threw = true;
    }
    if (!threw) {
      fail(`parseEvidence('bogus-kind-xyz:payload') should have thrown for unknown kind`);
    } else {
      pass(`parseEvidence correctly rejects unknown atom kinds`);
    }
  } catch (e) {
    fail(`Failed to import built evidence module: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// Check 3: Fake decision ID is rejected (validateAtom returns error)
// ---------------------------------------------------------------------------
async function checkFakeDecisionRejected() {
  console.log('\n--- Check 3: Fake decision ID is rejected ---');

  const evidenceJsPath = join(
    REPO_ROOT,
    'packages',
    'core',
    'dist',
    'tasks',
    'evidence.js',
  );
  if (!existsSync(evidenceJsPath)) {
    fail(`packages/core/dist/tasks/evidence.js not found — skipping runtime check`);
    return;
  }

  try {
    const mod = await import(evidenceJsPath);
    const { parseEvidence, validateAtom } = mod;

    if (typeof validateAtom !== 'function') {
      fail(`validateAtom not exported from built evidence module`);
      return;
    }

    let parsed;
    try {
      parsed = parseEvidence('decision:D-FAKE-99999-DOES-NOT-EXIST');
    } catch (e) {
      fail(`parseEvidence threw for fake decision ID (should parse, fail at validate): ${e.message}`);
      return;
    }

    const decisionAtom = parsed?.atoms?.find((a) => a.kind === 'decision');
    if (!decisionAtom) {
      fail(`parseEvidence did not produce a decision atom for fake ID`);
      return;
    }

    const result = await validateAtom(decisionAtom, REPO_ROOT);
    if (result.ok) {
      fail(
        `validateAtom accepted a fake decision ID 'D-FAKE-99999-DOES-NOT-EXIST' — ` +
        `expected rejection with E_EVIDENCE_INVALID_DECISION or similar`,
      );
    } else {
      pass(
        `validateAtom correctly rejected fake decision ID: ${result.codeName} — ${result.reason.slice(0, 100)}`,
      );
    }
  } catch (e) {
    fail(`Runtime check for fake decision rejection failed: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// Check 4: GATE_EVIDENCE_MINIMUMS accepts decision + files for implemented gate
// ---------------------------------------------------------------------------
function checkGateMinimums() {
  console.log('\n--- Check 4: GATE_EVIDENCE_MINIMUMS allows decision+files for implemented ---');

  const evidenceTs = join(REPO_ROOT, 'packages', 'core', 'src', 'tasks', 'evidence.ts');
  if (!existsSync(evidenceTs)) {
    fail(`packages/core/src/tasks/evidence.ts not found`);
    return;
  }

  const source = readFileSync(evidenceTs, 'utf8');

  // Find the GATE_EVIDENCE_MINIMUMS block
  const idx = source.indexOf('GATE_EVIDENCE_MINIMUMS');
  if (idx === -1) {
    fail('GATE_EVIDENCE_MINIMUMS not found in evidence.ts');
    return;
  }

  // Check that 'decision' appears in the implemented gate alternatives
  const implementedSection = source.slice(idx, idx + 600);
  if (!implementedSection.includes("'decision'") && !implementedSection.includes('"decision"')) {
    fail(
      `GATE_EVIDENCE_MINIMUMS implemented gate does not include 'decision' as a valid atom kind. ` +
      `Add ['decision', 'files'] or ['decision', 'note'] as an alternative set.`,
    );
  } else {
    pass(`GATE_EVIDENCE_MINIMUMS implemented gate includes 'decision' alternative`);
  }
}

// ---------------------------------------------------------------------------
// Check 5: CLEO-INJECTION.md updated with decision: example
// ---------------------------------------------------------------------------
function checkInjectionMd() {
  console.log('\n--- Check 5: CLEO-INJECTION.md includes decision: evidence atom example ---');

  const injectionPaths = [
    join(REPO_ROOT, 'packages', 'core', 'templates', 'CLEO-INJECTION.md'),
    join(REPO_ROOT, '.cleo', 'templates', 'CLEO-INJECTION.md'),
    join(process.env.HOME ?? '/root', '.cleo', 'templates', 'CLEO-INJECTION.md'),
  ];

  let found = false;
  for (const p of injectionPaths) {
    if (existsSync(p)) {
      const content = readFileSync(p, 'utf8');
      if (content.includes('decision:') && content.includes('D-')) {
        pass(`CLEO-INJECTION.md at ${p} includes decision: evidence atom example`);
        found = true;
        break;
      } else {
        // File exists but no decision: example
        fail(
          `CLEO-INJECTION.md at ${p} exists but does not include a decision: evidence atom example. ` +
          `Add: decision:<D-id> example to the Pre-Complete Gate Ritual section.`,
        );
        found = true;
        break;
      }
    }
  }

  if (!found) {
    fail(
      `CLEO-INJECTION.md not found at any expected path:\n` +
      injectionPaths.map((p) => `  - ${p}`).join('\n'),
    );
  }
}

// ---------------------------------------------------------------------------
// Check 6: Test file exists covering decision atom path
// ---------------------------------------------------------------------------
function checkTests() {
  console.log('\n--- Check 6: Tests exist for decision atom path ---');

  const testFiles = [
    join(REPO_ROOT, 'packages', 'core', 'src', 'tasks', '__tests__', 'evidence.test.ts'),
  ];

  let foundTest = false;
  for (const p of testFiles) {
    if (existsSync(p)) {
      const content = readFileSync(p, 'utf8');
      if (
        (content.includes("'decision:'") || content.includes("'decision:D")) &&
        (content.includes('describe') || content.includes('it(') || content.includes('test('))
      ) {
        pass(`Test file ${p.replace(REPO_ROOT + '/', '')} contains decision atom tests`);
        foundTest = true;
        break;
      } else if (content.includes('decision')) {
        pass(`Test file ${p.replace(REPO_ROOT + '/', '')} references decision (partial coverage detected)`);
        foundTest = true;
        break;
      }
    }
  }

  if (!foundTest) {
    // Look more broadly
    try {
      const result = execSync(
        `grep -r "decision" ${join(REPO_ROOT, 'packages/core/src')} --include="*.test.ts" -l 2>/dev/null`,
        { encoding: 'utf8', timeout: 10000 },
      ).trim();
      if (result) {
        pass(`Found decision-related test coverage in:\n  ${result.split('\n').slice(0, 3).join('\n  ')}`);
        foundTest = true;
      }
    } catch {
      // ignore grep failure
    }
  }

  if (!foundTest) {
    fail(
      `No test file found covering the decision atom path. ` +
      `Add tests to packages/core/src/tasks/__tests__/evidence.test.ts covering:\n` +
      `  - parseEvidence('decision:D-001') produces decision atom\n` +
      `  - validateAtom rejects fake decision ID with E_EVIDENCE_INVALID_DECISION\n` +
      `  - GATE_EVIDENCE_MINIMUMS satisfied by [decision, files] combo`,
    );
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log('=== T1875 Verifier: Add decision evidence atom kind ===\n');
  console.log(`Repo root: ${REPO_ROOT}`);

  checkContractsType();
  await checkParseEvidence();
  await checkFakeDecisionRejected();
  checkGateMinimums();
  checkInjectionMd();
  checkTests();

  console.log('\n--- Summary ---');
  if (failures.length > 0) {
    console.error(`\nFAILED: ${failures.length} check(s) failed:`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  } else {
    console.log('\nALL CHECKS PASSED. T1875 AC satisfied.');
    process.exit(0);
  }
}

main().catch((e) => {
  console.error('Verifier crashed:', e);
  process.exit(1);
});
