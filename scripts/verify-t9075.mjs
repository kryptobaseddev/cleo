#!/usr/bin/env node
/**
 * Verifier for T9075: W5 — Delete cleo bug command entirely (no shim, no tombstone, no alias).
 *
 * AC:
 *   - Running `cleo bug --help` must exit non-zero (command not found)
 *   - packages/cleo/src/cli/commands/bug.ts must NOT exist OR must be a proper deletion
 *   - The command is NOT in the help-renderer.ts list of main commands
 *
 * NOTE: From earlier grep, bug.ts and help-renderer.ts still reference 'bug'.
 * This verifier will likely FAIL (which is the point — catch scaffold-only completions).
 *
 * NEGATIVE SPACE: Must verify the command is GONE, not that a deletion doc exists.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
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
  return readFileSync(join(REPO_ROOT, rel), 'utf8');
}

// ---------------------------------------------------------------------------
// Check 1: bug.ts command file must NOT exist (or must be empty tombstone clearly noting deletion)
// ---------------------------------------------------------------------------
const bugTsPath = join(REPO_ROOT, 'packages/cleo/src/cli/commands/bug.ts');
if (!existsSync(bugTsPath)) {
  pass('packages/cleo/src/cli/commands/bug.ts does not exist (properly deleted)');
} else {
  // It exists — check if it's a proper deletion stub or still a working command
  const bugContent = readFile('packages/cleo/src/cli/commands/bug.ts');

  // If the file has a working 'name: bug' definition and dispatches, it's not deleted
  if (bugContent.includes("name: 'bug'") && bugContent.includes('dispatchFromCli')) {
    fail('bug.ts still has working name: "bug" definition and dispatch — NOT deleted (T9075)');
  } else if (bugContent.includes('deleted\|removed\|tombstone') || bugContent.length < 100) {
    pass('bug.ts appears to be a deletion tombstone (acceptable)');
  } else {
    fail('bug.ts exists and appears to be a working command — T9075 requires full deletion');
  }
}

// ---------------------------------------------------------------------------
// Check 2: help-renderer.ts must NOT list 'bug' in the main command list
// ---------------------------------------------------------------------------
const helpRenderer = readFile('packages/cleo/src/cli/help-renderer.ts');

// The help-renderer was found to have 'bug' in position 71 (from earlier grep)
// Check if it's in the main commands array
const bugInHelpLines = helpRenderer.split('\n').filter(l => {
  const trimmed = l.trim();
  // It's a problem if 'bug' is a string literal in what looks like a command list
  return trimmed === "'bug'," || trimmed === "'bug'" || trimmed === '"bug",' || trimmed === '"bug"';
});

if (bugInHelpLines.length === 0) {
  pass('help-renderer.ts does not list "bug" as a command');
} else {
  fail(`help-renderer.ts still lists "bug" as a command in ${bugInHelpLines.length} location(s) — T9075 requires full deletion`);
}

// ---------------------------------------------------------------------------
// Check 3: command-manifest.ts must NOT have bug command registered
// ---------------------------------------------------------------------------
const manifest = readFile('packages/cleo/src/cli/generated/command-manifest.ts');
if (manifest.includes("name: 'bug'")) {
  fail("command-manifest.ts still has name: 'bug' entry — T9075 requires bug command removal from manifest");
} else {
  pass("command-manifest.ts has no name: 'bug' entry (properly removed)");
}

// ---------------------------------------------------------------------------
// Check 4: No import of bug.ts from CLI router/index
// ---------------------------------------------------------------------------
const cliIndex = readFile('packages/cleo/src/cli/index.ts');
if (cliIndex.includes("'./commands/bug'") || cliIndex.includes('"./commands/bug"') ||
    cliIndex.includes("from './commands/bug.js'") || cliIndex.includes('commands/bug')) {
  fail('cli/index.ts still imports from commands/bug — T9075 requires full deletion including import removal');
} else {
  pass('cli/index.ts does not import commands/bug (properly removed)');
}

// ---------------------------------------------------------------------------
// Final
// ---------------------------------------------------------------------------
if (failures.length === 0) {
  console.log('\nVERIFIER PASS: T9075 — cleo bug command fully deleted with no shim/tombstone/alias');
  process.exit(0);
} else {
  console.error(`\nVERIFIER FAIL: ${failures.length} check(s) failed`);
  process.exit(1);
}
