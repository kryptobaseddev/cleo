#!/usr/bin/env node
/**
 * Verifier for T9191 (T9064-FU): cleo agent-outputs find CLI command.
 *
 * AC checks:
 *   1. `cleo agent-outputs find --help` exits 0 and output mentions 'agent-outputs'.
 *   2. Command is registered in command-manifest.ts (static check).
 *   3. DocsAccessor.searchDocs is wired (the CLI calls it).
 *
 * Exit 0 only if ALL checks pass.
 *
 * @task T9191
 * @see scripts/verify-t9191-fu.mjs
 */

import { execSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

console.log('=== T9191 Verifier: cleo agent-outputs find CLI command ===\n');

const failures = [];

function fail(msg) {
  console.error('FAIL:', msg);
  failures.push(msg);
}

function pass(msg) {
  console.log('PASS:', msg);
}

// ---------------------------------------------------------------------------
// Check 1: cleo agent-outputs find --help exits 0
// ---------------------------------------------------------------------------

console.log('--- Check 1: cleo agent-outputs find --help ---');

// Try the installed `cleo` first; fall back to the built dist in the monorepo.
const CLEO_DIST = join(REPO_ROOT, 'packages', 'cleo', 'dist', 'cli', 'index.js');
const helpArgs = ['agent-outputs', 'find', '--help'];
let helpResult = spawnSync('cleo', helpArgs, { encoding: 'utf8', cwd: REPO_ROOT });
if (helpResult.status !== 0 || /Unknown command/.test(helpResult.stderr || '')) {
  // Installed cleo is old — fall back to built dist
  helpResult = spawnSync('node', [CLEO_DIST, ...helpArgs], { encoding: 'utf8', cwd: REPO_ROOT });
}

if (helpResult.error) {
  fail(`Failed to run cleo: ${helpResult.error.message}`);
} else if (helpResult.status !== 0) {
  const stderr = helpResult.stderr || '';
  const stdout = helpResult.stdout || '';
  fail(
    `cleo agent-outputs find --help exited with status ${helpResult.status}.\n` +
      `  stdout: ${stdout.slice(0, 300)}\n` +
      `  stderr: ${stderr.slice(0, 300)}\n\n` +
      `  T9191 AC requires 'cleo agent-outputs find' to be a registered CLI command.\n` +
      `  DocsAccessor.searchDocs exists; the CLI surface is missing.\n` +
      `  Register the command in packages/cleo/src/cli/commands/ and command-manifest.ts.`,
  );
} else {
  const output = (helpResult.stdout || '') + (helpResult.stderr || '');
  if (!/agent.outputs/i.test(output)) {
    fail(
      `cleo agent-outputs find --help exited 0 but output does not mention 'agent-outputs': ${output.slice(0, 200)}`,
    );
  } else {
    pass(`cleo agent-outputs find --help: exit 0, output mentions 'agent-outputs'`);
  }
}

// ---------------------------------------------------------------------------
// Check 2: command-manifest.ts registers agent-outputs find
// ---------------------------------------------------------------------------

console.log('\n--- Check 2: command-manifest.ts registration ---');

const manifestPath = join(REPO_ROOT, 'packages/cleo/src/cli/generated/command-manifest.ts');

if (!existsSync(manifestPath)) {
  fail(`command-manifest.ts not found at ${manifestPath}`);
} else {
  const manifest = readFileSync(manifestPath, 'utf8');
  if (!/agent.outputs/i.test(manifest) || !/find/i.test(manifest)) {
    fail(
      `command-manifest.ts does not register 'agent-outputs find'.\n` +
        `  The command must appear in packages/cleo/src/cli/generated/command-manifest.ts.`,
    );
  } else {
    pass(`command-manifest.ts contains 'agent-outputs find' registration`);
  }
}

// ---------------------------------------------------------------------------
// Check 3: DocsAccessor.searchDocs wired in CLI
// ---------------------------------------------------------------------------

console.log('\n--- Check 3: DocsAccessor.searchDocs wired in CLI ---');

// Find any command file that imports/calls searchDocs for agent-outputs
let _searchDocsWired = false;
try {
  const result = execSync(
    `grep -rn "searchDocs\\|agent-outputs.*find\\|AgentOutput" packages/cleo/src/cli --include="*.ts" 2>/dev/null || true`,
    { encoding: 'utf8', cwd: REPO_ROOT },
  );
  // We need it to reference searchDocs in context of agent-outputs
  const lines = result.split('\n').filter((l) => l.trim());
  const relevantLines = lines.filter(
    (l) => l.includes('searchDocs') && !l.includes('.test.') && !l.includes('.spec.'),
  );
  if (relevantLines.length > 0) {
    _searchDocsWired = true;
    pass(`searchDocs wired in CLI (${relevantLines.length} reference(s))`);
    for (const l of relevantLines.slice(0, 3)) {
      console.log('  ' + l);
    }
  } else {
    fail(
      `searchDocs not found in CLI command files.\n` +
        `  The 'cleo agent-outputs find' command must call DocsAccessor.searchDocs.\n` +
        `  DocsAccessor is the abstraction — do not call the brain/llmtxt layers directly.`,
    );
  }
} catch (e) {
  fail(`Error checking searchDocs wiring: ${e.message}`);
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
  console.log('\nALL CHECKS PASSED. T9191 AC satisfied.');
  process.exit(0);
}
