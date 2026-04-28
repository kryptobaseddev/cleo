#!/usr/bin/env node

/**
 * execute-payload.mjs — Post-deploy step runner for the release pipeline.
 *
 * Invoked by `.github/workflows/release.yml` in the `execute-payload` job
 * AFTER all packages have been published to npm and the GitHub Release has
 * been created. Runs three classes of post-deploy work:
 *
 *   1. npm publish verification  — confirm every @cleocode/* package at
 *      <VERSION> is resolvable from the public npm registry.
 *   2. Deployment summary        — emit a structured JSON artifact that
 *      records which packages were verified, the timestamp, and the
 *      version. Used by downstream automation (registry announce, etc.).
 *   3. Post-deploy smoke         — a lightweight echo that confirms the
 *      script itself ran end-to-end (captured as a CI artifact).
 *
 * Exit codes:
 *   0 — all steps passed
 *   1 — one or more npm verify steps failed (packages not resolvable)
 *
 * Usage:
 *   node scripts/execute-payload.mjs --version 2026.4.xxx [--output-dir /tmp]
 */

import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

/**
 * Parse CLI arguments into a flat key/value map.
 * @param {string[]} argv
 * @returns {{ version: string; outputDir: string }}
 */
function parseArgs(argv) {
  const result = { version: '', outputDir: '/tmp/postdeploy-artifacts' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--version' && argv[i + 1]) {
      result.version = argv[++i];
    } else if (arg === '--output-dir' && argv[i + 1]) {
      result.outputDir = argv[++i];
    }
  }
  return result;
}

const args = parseArgs(process.argv.slice(2));

if (!args.version) {
  console.error('ERROR: --version <VERSION> is required');
  process.exit(1);
}

const { version, outputDir } = args;

// ---------------------------------------------------------------------------
// Published packages (must match release.yml publish order)
// ---------------------------------------------------------------------------

/** @type {string[]} */
const PUBLISHED_PACKAGES = [
  'contracts',
  'lafs',
  'worktree',
  'git-shim',
  'core',
  'caamp',
  'cant',
  'nexus',
  'brain',
  'runtime',
  'adapters',
  'agents',
  'skills',
  'playbooks',
  'cleo',
  'cleo-os',
  'mcp-adapter',
];

// ---------------------------------------------------------------------------
// Step 1: npm registry verification
// ---------------------------------------------------------------------------

/**
 * Verify a single @cleocode/<pkg>@<version> is resolvable on the public registry.
 * Uses `npm view` with a 30 s timeout and retries once on failure.
 * Calls execFileSync with an explicit argument array to prevent shell injection.
 * @param {string} pkg - Short package name (e.g. "core")
 * @param {string} ver - Full version string (e.g. "2026.4.141")
 * @returns {{ pkg: string; ok: boolean; reason?: string }}
 */
function verifyPackage(pkg, ver) {
  const spec = `@cleocode/${pkg}@${ver}`;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const out = execFileSync(
        'npm',
        ['view', spec, 'version', '--registry', 'https://registry.npmjs.org'],
        { timeout: 30_000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
      ).trim();
      if (out === ver) {
        return { pkg, ok: true };
      }
      return { pkg, ok: false, reason: `registry returned version "${out}", expected "${ver}"` };
    } catch (err) {
      if (attempt === 2) {
        const msg = err instanceof Error ? err.message.split('\n')[0] : String(err);
        return { pkg, ok: false, reason: msg };
      }
      // brief back-off before retry
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        /* spin-wait */
      }
    }
  }
  return { pkg, ok: false, reason: 'unreachable' };
}

console.log(`\n=== execute-payload: post-deploy steps for v${version} ===\n`);
console.log(`Step 1: Verify npm registry — checking ${PUBLISHED_PACKAGES.length} packages...\n`);

/** @type {Array<{ pkg: string; ok: boolean; reason?: string }>} */
const verifyResults = [];
for (const pkg of PUBLISHED_PACKAGES) {
  const result = verifyPackage(pkg, version);
  const icon = result.ok ? 'OK' : 'FAIL';
  const suffix = result.ok ? '' : `  (${result.reason})`;
  console.log(`  [${icon}] @cleocode/${pkg}@${version}${suffix}`);
  verifyResults.push(result);
}

const failures = verifyResults.filter((r) => !r.ok);
const passed = verifyResults.filter((r) => r.ok);
console.log(
  `\nRegistry verification: ${passed.length}/${PUBLISHED_PACKAGES.length} packages confirmed`,
);

// ---------------------------------------------------------------------------
// Step 2: Deployment summary artifact
// ---------------------------------------------------------------------------

console.log('\nStep 2: Writing deployment summary artifact...');

/** @type {Record<string, unknown>} */
const summary = {
  version,
  timestamp: new Date().toISOString(),
  registry: 'https://registry.npmjs.org',
  packages: verifyResults.map(({ pkg, ok, reason }) => ({
    name: `@cleocode/${pkg}`,
    version,
    verified: ok,
    ...(reason ? { reason } : {}),
  })),
  stats: {
    total: PUBLISHED_PACKAGES.length,
    verified: passed.length,
    failed: failures.length,
  },
};

await mkdir(outputDir, { recursive: true });
const summaryPath = path.join(outputDir, `deploy-summary-${version}.json`);
await writeFile(summaryPath, JSON.stringify(summary, null, 2), 'utf8');
console.log(`  Summary written to: ${summaryPath}`);

// ---------------------------------------------------------------------------
// Step 3: Smoke confirmation
// ---------------------------------------------------------------------------

console.log('\nStep 3: Post-deploy smoke...');
const smokePath = path.join(outputDir, `smoke-${version}.txt`);
const smokeContent = [
  'execute-payload ran successfully',
  `version: ${version}`,
  `timestamp: ${summary.timestamp}`,
  `packages_verified: ${passed.length}/${PUBLISHED_PACKAGES.length}`,
  '',
  'PASS: execute-payload complete',
].join('\n');
await writeFile(smokePath, smokeContent, 'utf8');
console.log(`  Smoke file written to: ${smokePath}`);
console.log('\n  PASS: execute-payload complete\n');

// ---------------------------------------------------------------------------
// Exit
// ---------------------------------------------------------------------------

if (failures.length > 0) {
  console.error(
    `\n::error::Post-deploy registry verification failed for: ${failures.map((f) => f.pkg).join(', ')}`,
  );
  console.error('These packages published but are not yet resolvable on the public registry.');
  console.error(
    'This is often a registry propagation delay — retry the workflow in a few minutes.',
  );
  process.exit(1);
}

console.log(`=== execute-payload: all steps passed for v${version} ===\n`);
