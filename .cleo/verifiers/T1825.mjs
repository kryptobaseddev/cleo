#!/usr/bin/env node

/**
 * Verifier for T1825: Migrate docs/adr/ → .cleo/adrs/ + archive vs migrate decision.
 *
 * This script is the acceptance criterion for T1825. It MUST exit non-zero
 * before the implementation lands. It MUST exit 0 after.
 *
 * Checks:
 * 1. .cleo/adrs/ directory exists and has at least 56 ADR files (existing 58 + migrated)
 * 2. All 17 docs/adr/ files are accounted for: migrated to .cleo/adrs/ OR archived with manifest entry
 * 3. docs/adr/ is either removed, empty, or contains only an archive marker
 * 4. cleo adr list returns ADRs from .cleo/adrs/ (the ADR command surface works)
 * 5. All in-codebase source references to docs/adr/* have been updated
 * 6. Migration manifest (.cleo/adrs/T1825-migration-manifest.json) exists and is valid
 * 7. Round-trip: at least one migrated ADR is readable via cleo adr show
 *
 * @task T1825
 * @epic T1824
 */

import { execSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const failures = [];
const warnings = [];

function fail(msg) {
  console.error('FAIL:', msg);
  failures.push(msg);
}

function warn(msg) {
  console.warn('WARN:', msg);
  warnings.push(msg);
}

function pass(msg) {
  console.log('PASS:', msg);
}

// The 17 files that were in docs/adr/ at the start of T1825.
// Implementer must account for every one.
const LEGACY_DOCS_ADR_FILES = [
  'ADR-051-override-patterns.md',
  'ADR-052-sdk-consolidation.md',
  'ADR-053-playbook-runtime.md',
  'ADR-054-migration-system-hybrid-path-a-plus.md',
  'ADR-055-agents-architecture-and-meta-agents.md',
  'ADR-056-db-ssot-and-release-completion-invariant.md',
  'ADR-057-contracts-core-ssot.md',
  'ADR-058-dispatch-type-inference.md',
  'ADR-059-override-pumps.md',
  'ADR-061-project-agnostic-verify-tools.md',
  'ADR-062-worktree-merge-not-cherry-pick.md',
  'ADR-063-release-pipeline.md',
  'ADR-064-caamp-adapters-boundary.md',
  'ADR-065-pr-required-release-flow.md',
  'ADR-066-task-taxonomy-consolidation.md',
  'ADR-070-verifier-backed-ac-auditor-loop.md',
  'adr-cleoos-sentient-harness.md',
];

// ---------------------------------------------------------------------------
// Check 1: .cleo/adrs/ exists and has ADR files
// ---------------------------------------------------------------------------
function checkCleoadrs() {
  console.log('\n--- Check 1: .cleo/adrs/ exists and contains ADR files ---');
  const adrsDir = join(REPO_ROOT, '.cleo', 'adrs');

  if (!existsSync(adrsDir)) {
    fail('.cleo/adrs/ directory does not exist');
    return;
  }

  const files = readdirSync(adrsDir).filter((f) => f.endsWith('.md'));
  if (files.length < 56) {
    fail(`.cleo/adrs/ has only ${files.length} .md files — expected at least 56 after migration`);
  } else {
    pass(`.cleo/adrs/ exists and contains ${files.length} .md files`);
  }
}

// ---------------------------------------------------------------------------
// Check 2: Every docs/adr file is accounted for (migrated OR archived)
// ---------------------------------------------------------------------------
function checkAllAccountedFor() {
  console.log('\n--- Check 2: All 17 legacy docs/adr/ files accounted for ---');
  const adrsDir = join(REPO_ROOT, '.cleo', 'adrs');
  const manifestPath = join(adrsDir, 'T1825-migration-manifest.json');

  // Load migration manifest if present
  let manifest = null;
  if (existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      pass('T1825-migration-manifest.json exists and is valid JSON');
    } catch (e) {
      fail(`T1825-migration-manifest.json is not valid JSON: ${e.message}`);
      return;
    }
  } else {
    fail(
      'T1825-migration-manifest.json does not exist in .cleo/adrs/ — ' +
        'Implementer must create this manifest documenting the migration/archive decision for each file',
    );
  }

  const adrsFiles = existsSync(adrsDir) ? readdirSync(adrsDir) : [];

  const unaccounted = [];
  for (const legacy of LEGACY_DOCS_ADR_FILES) {
    // Option A: file was migrated into .cleo/adrs/ (exact or renamed)
    const legacyBase = legacy.replace(/\.md$/, '');

    // Normalise: strip the docs/adr naming quirks e.g. "ADR-051-override-patterns"
    const migratedExact = adrsFiles.some(
      (f) => f === legacy || f.replace(/\.md$/, '') === legacyBase,
    );

    // Option B: entry in manifest marks it as archived or re-numbered
    const inManifest =
      manifest?.entries?.some((e) => e.source === legacy || e.source === `docs/adr/${legacy}`) ??
      false;

    if (migratedExact) {
      pass(`${legacy} — migrated (found in .cleo/adrs/)`);
    } else if (inManifest) {
      const entry = manifest.entries.find(
        (e) => e.source === legacy || e.source === `docs/adr/${legacy}`,
      );
      pass(`${legacy} — accounted for in manifest (action: ${entry?.action ?? 'recorded'})`);
    } else {
      unaccounted.push(legacy);
    }
  }

  if (unaccounted.length > 0) {
    fail(
      `${unaccounted.length} docs/adr/ files not accounted for (neither migrated nor in manifest):\n` +
        unaccounted.map((f) => `  - ${f}`).join('\n'),
    );
  } else {
    pass('All 17 legacy docs/adr/ files are accounted for');
  }
}

// ---------------------------------------------------------------------------
// Check 3: docs/adr/ is empty / removed / contains only archive marker
// ---------------------------------------------------------------------------
function checkDocsAdrCleaned() {
  console.log('\n--- Check 3: docs/adr/ is empty, removed, or archive-only ---');
  const docsAdrDir = join(REPO_ROOT, 'docs', 'adr');

  if (!existsSync(docsAdrDir)) {
    pass('docs/adr/ directory removed — clean');
    return;
  }

  const remaining = readdirSync(docsAdrDir).filter((f) => f !== 'ARCHIVED.md' && f !== '.gitkeep');
  if (remaining.length === 0) {
    pass('docs/adr/ exists but contains only archive markers — clean');
  } else {
    fail(
      `docs/adr/ still contains ${remaining.length} unrelocated file(s):\n` +
        remaining
          .slice(0, 10)
          .map((f) => `  - ${f}`)
          .join('\n'),
    );
  }
}

// ---------------------------------------------------------------------------
// Check 4: cleo adr list returns ADRs
// ---------------------------------------------------------------------------
async function checkCleoadrList() {
  console.log('\n--- Check 4: cleo adr list returns ADRs from .cleo/adrs/ ---');
  try {
    const output = execSync('cleo adr list 2>&1', {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 15000,
    });

    let parsed;
    try {
      parsed = JSON.parse(output);
    } catch {
      // non-JSON output — check for keyword
      if (output.includes('ADR-') || output.includes('accepted')) {
        pass('cleo adr list returned ADR data (non-JSON format detected)');
        return;
      }
      fail(`cleo adr list did not return recognisable ADR data. Output: ${output.slice(0, 200)}`);
      return;
    }

    const adrs = parsed?.data?.adrs ?? [];
    if (adrs.length < 56) {
      fail(
        `cleo adr list returned only ${adrs.length} ADRs — expected at least 56 after migration`,
      );
    } else {
      pass(`cleo adr list returned ${adrs.length} ADRs — above migration threshold`);
    }

    // Check no docs/adr/ paths appear as filePath in the results
    const docsAdrPaths = adrs.filter((a) => a.filePath?.includes('/docs/adr/'));
    if (docsAdrPaths.length > 0) {
      fail(
        `cleo adr list still returns ${docsAdrPaths.length} ADR(s) from docs/adr/ paths — ` +
          'they should now be served from .cleo/adrs/:\n' +
          docsAdrPaths
            .slice(0, 5)
            .map((a) => `  - ${a.filePath}`)
            .join('\n'),
      );
    } else {
      pass('cleo adr list returns no docs/adr/ paths — all from .cleo/adrs/');
    }
  } catch (e) {
    fail(`cleo adr list threw: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// Check 5: In-codebase source references to docs/adr/* updated
// ---------------------------------------------------------------------------
function checkSourceRefs() {
  console.log('\n--- Check 5: Source files no longer hard-code docs/adr/ paths ---');

  // Files that are allowed to still mention docs/adr/ (historically/contextually):
  const ALLOWLIST = [
    'CHANGELOG.md', // historical entries
    'adr-backfill-walker.ts', // deliberately reads docs/adr/ as fallback source
    'T1825-migration-manifest.json', // the manifest itself
    'verify-t1825.mjs', // this verifier
    '/skills/', // skills fixture/reference files (not production code)
    'fixtures/', // test fixtures
    '__tests__/', // test files that use docs/adr/ as example strings
    'README.md', // documentation files
    'AGENTS.md', // documentation files
  ];

  const sourceFilePatterns = [join(REPO_ROOT, 'packages'), join(REPO_ROOT, 'scripts')];

  const violators = [];

  function scanDir(dir) {
    if (!existsSync(dir)) return;
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        scanDir(fullPath);
      } else if (
        entry.name.endsWith('.ts') ||
        entry.name.endsWith('.mjs') ||
        entry.name.endsWith('.md')
      ) {
        const relPath = fullPath.replace(REPO_ROOT + '/', '');
        const allowed = ALLOWLIST.some((a) => fullPath.includes(a) || relPath.includes(a));
        if (allowed) continue;
        try {
          const content = readFileSync(fullPath, 'utf8');
          if (
            content.includes("'docs/adr/") ||
            content.includes('"docs/adr/') ||
            content.includes('`docs/adr/')
          ) {
            violators.push(fullPath.replace(REPO_ROOT + '/', ''));
          }
        } catch {
          // skip unreadable
        }
      }
    }
  }

  for (const root of sourceFilePatterns) {
    scanDir(root);
  }

  if (violators.length > 0) {
    fail(
      `${violators.length} source file(s) still reference docs/adr/ paths:\n` +
        violators.map((f) => `  - ${f}`).join('\n'),
    );
  } else {
    pass('No source files reference docs/adr/ paths (allowlisted files excluded)');
  }
}

// ---------------------------------------------------------------------------
// Check 6: Migration manifest is valid and complete
// ---------------------------------------------------------------------------
function checkManifest() {
  console.log('\n--- Check 6: T1825-migration-manifest.json is valid and complete ---');
  const manifestPath = join(REPO_ROOT, '.cleo', 'adrs', 'T1825-migration-manifest.json');

  if (!existsSync(manifestPath)) {
    fail('T1825-migration-manifest.json does not exist — skipping manifest validation');
    return;
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    fail(`T1825-migration-manifest.json parse error: ${e.message}`);
    return;
  }

  const requiredFields = ['task', 'decidedAt', 'decision', 'entries'];
  const missing = requiredFields.filter((f) => !(f in manifest));
  if (missing.length > 0) {
    fail(`T1825-migration-manifest.json missing required fields: ${missing.join(', ')}`);
    return;
  }

  if (!Array.isArray(manifest.entries)) {
    fail('T1825-migration-manifest.json entries field is not an array');
    return;
  }

  if (manifest.entries.length < 17) {
    fail(
      `T1825-migration-manifest.json has only ${manifest.entries.length} entries — ` +
        'expected at least 17 (one per legacy docs/adr/ file)',
    );
    return;
  }

  const validActions = ['migrated', 'archived', 'renumbered', 'merged'];
  const badEntries = manifest.entries.filter((e) => !validActions.includes(e.action));
  if (badEntries.length > 0) {
    fail(
      `${badEntries.length} manifest entries have invalid action (expected one of: ${validActions.join(', ')}):\n` +
        badEntries
          .slice(0, 5)
          .map((e) => `  - ${JSON.stringify(e)}`)
          .join('\n'),
    );
  } else {
    pass(
      `T1825-migration-manifest.json valid: ${manifest.entries.length} entries, all with valid actions`,
    );
  }
}

// ---------------------------------------------------------------------------
// Check 7: Round-trip — cleo adr show for one migrated ADR
// ---------------------------------------------------------------------------
async function checkRoundTrip() {
  console.log('\n--- Check 7: Round-trip cleo adr show on a migrated ADR ---');

  // ADR-051 existed in BOTH locations — after migration it should be in .cleo/adrs/ only
  const testAdrId = 'ADR-051';

  try {
    const output = execSync(`cleo adr show ${testAdrId} 2>&1`, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 15000,
    });

    if (!output.includes('ADR-051') && !output.includes('override') && !output.includes('gate')) {
      warn(
        `cleo adr show ${testAdrId} returned output that doesn't mention expected content. ` +
          `Output: ${output.slice(0, 200)}`,
      );
    } else {
      pass(`cleo adr show ${testAdrId} returned readable content`);
    }

    // Verify path is in .cleo/adrs/ not docs/adr/
    if (output.includes('/docs/adr/')) {
      fail(`cleo adr show ${testAdrId} is serving from docs/adr/ — must be from .cleo/adrs/`);
    } else {
      pass(`cleo adr show ${testAdrId} does not reference docs/adr/ path`);
    }
  } catch (e) {
    fail(`cleo adr show ${testAdrId} threw: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log('=== T1825 Verifier: Migrate docs/adr/ → .cleo/adrs/ ===\n');
  console.log(`Repo root: ${REPO_ROOT}`);

  checkCleoadrs();
  checkAllAccountedFor();
  checkDocsAdrCleaned();
  await checkCleoadrList();
  checkSourceRefs();
  checkManifest();
  await checkRoundTrip();

  console.log('\n--- Summary ---');
  if (warnings.length > 0) {
    console.warn(`\n${warnings.length} warning(s):`);
    for (const w of warnings) console.warn(`  - ${w}`);
  }

  if (failures.length > 0) {
    console.error(`\nFAILED: ${failures.length} check(s) failed:`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  } else {
    console.log('\nALL CHECKS PASSED. T1825 AC satisfied.');
    process.exit(0);
  }
}

main().catch((e) => {
  console.error('Verifier crashed:', e);
  process.exit(1);
});
