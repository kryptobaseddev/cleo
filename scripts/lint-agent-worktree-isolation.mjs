#!/usr/bin/env node
/**
 * Agent Worktree Isolation Lint (T9808 / council D009).
 *
 * Scans agent transcript files under `.cleo/agent-outputs/` and flags any
 * `EnterWorktree` tool invocations — which indicate that an agent used
 * Claude Code's built-in isolation:worktree rather than the canonical
 * `cleo orchestrate spawn` / XDG worktree provisioning flow mandated by
 * ADR-055 and T1140.
 *
 * Violation pattern
 * -----------------
 * Claude Code's isolation:worktree feature auto-provisions a git worktree
 * in an OS temp dir rather than under the canonical XDG layout
 * (`<cleoHome>/worktrees/<projectHash>/<taskId>/`). These rogue worktrees:
 *   - Bypass the git-shim isolation guards (ADR-055)
 *   - Are not registered in `worktree_registry` (T9807)
 *   - May produce orphan .cleo/ directories (T9550/T9580 class bugs)
 *   - Don't auto-clean on PR merge (T9805 lifecycle hooks)
 *
 * Usage
 * -----
 *   # Scan all agent outputs:
 *   node scripts/lint-agent-worktree-isolation.mjs
 *
 *   # Fail with exit code 1 if violations found (for CI):
 *   node scripts/lint-agent-worktree-isolation.mjs --fail-on-violations
 *
 *   # Scan a specific directory:
 *   node scripts/lint-agent-worktree-isolation.mjs --dir .cleo/rcasd
 *
 * Output
 * ------
 * - On clean:     prints "PASS — no EnterWorktree violations found"
 * - On violation: prints a table of offending files + line numbers
 * - Exit code 0 always (non-blocking CI warning) unless --fail-on-violations.
 *
 * @task T9808
 * @epic T9808
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const REPO_ROOT = resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const failOnViolations = args.includes('--fail-on-violations');
const dirIndex = args.indexOf('--dir');
const customDir = dirIndex >= 0 ? args[dirIndex + 1] : null;

const scanRoot = customDir ? resolve(customDir) : join(REPO_ROOT, '.cleo', 'agent-outputs');

// ---------------------------------------------------------------------------
// Violation patterns
// ---------------------------------------------------------------------------

/**
 * Patterns that indicate `isolation:worktree` (Claude Code Agent built-in)
 * was used rather than the canonical cleo orchestrate spawn flow.
 *
 * We look for:
 *   1. `"type":"EnterWorktree"` in JSON tool invocations
 *   2. `isolation: worktree` in YAML-like agent config blocks
 *   3. The literal string `EnterWorktree` anywhere in a transcript
 */
const VIOLATION_PATTERNS = [
  {
    id: 'json-enter-worktree',
    regex: /"type"\s*:\s*"EnterWorktree"/g,
    description: 'JSON tool invocation: {"type":"EnterWorktree",...}',
  },
  {
    id: 'yaml-isolation-worktree',
    regex: /isolation\s*:\s*worktree/gi,
    description: 'YAML/text config: isolation: worktree',
  },
  {
    id: 'bare-enter-worktree',
    regex: /\bEnterWorktree\b/g,
    description: 'Bare EnterWorktree identifier in transcript',
  },
];

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

/**
 * @typedef {{file: string, lineNumber: number, patternId: string, description: string, excerpt: string}} Violation
 */

/** @type {Array<{file: string, lineNumber: number, patternId: string, description: string, excerpt: string}>} */
const violations = [];

/**
 * Recursively collect all `.md`, `.json`, `.jsonl`, and `.txt` files under
 * `dir`. We skip `.git/` and `node_modules/` to keep scans fast.
 *
 * @param {string} dir
 * @returns {string[]}
 */
function collectFiles(dir) {
  /** @type {string[]} */
  const files = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(full));
    } else if (entry.isFile()) {
      const ext = entry.name.split('.').pop() ?? '';
      if (['md', 'json', 'jsonl', 'txt'].includes(ext)) {
        files.push(full);
      }
    }
  }
  return files;
}

/**
 * Scan a single file for violation patterns. Appends to `violations`.
 *
 * @param {string} filePath
 */
function scanFile(filePath) {
  let content;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch {
    return;
  }
  const lines = content.split('\n');
  for (const pattern of VIOLATION_PATTERNS) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      pattern.regex.lastIndex = 0;
      if (pattern.regex.test(line)) {
        violations.push({
          file: relative(REPO_ROOT, filePath),
          lineNumber: i + 1,
          patternId: pattern.id,
          description: pattern.description,
          excerpt: line.trim().slice(0, 120),
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

process.stdout.write(`[worktree-isolation-lint] Scanning: ${scanRoot}\n`);

let fileCount = 0;
try {
  statSync(scanRoot);
} catch {
  process.stdout.write(`[worktree-isolation-lint] SKIP — scan root does not exist: ${scanRoot}\n`);
  process.exit(0);
}

const files = collectFiles(scanRoot);
fileCount = files.length;

for (const f of files) {
  scanFile(f);
}

process.stdout.write(`[worktree-isolation-lint] Scanned ${fileCount} file(s)\n`);

if (violations.length === 0) {
  process.stdout.write(
    '[worktree-isolation-lint] PASS — no EnterWorktree isolation violations found\n',
  );
  process.exit(0);
}

// Report violations.
process.stderr.write(
  `[worktree-isolation-lint] WARN — ${violations.length} EnterWorktree violation(s) detected\n`,
);
process.stderr.write(
  '[worktree-isolation-lint] These indicate an agent used Claude Code isolation:worktree\n',
);
process.stderr.write(
  '[worktree-isolation-lint] instead of cleo orchestrate spawn / XDG canonical flow.\n',
);
process.stderr.write('[worktree-isolation-lint] See ADR-055 + T1140 for correct patterns.\n');
process.stderr.write('\n');

for (const v of violations) {
  process.stderr.write(`  ${v.file}:${v.lineNumber}  [${v.patternId}]  ${v.description}\n`);
  process.stderr.write(`    > ${v.excerpt}\n`);
}

process.stderr.write(`\n[worktree-isolation-lint] ${violations.length} violation(s) total\n`);

if (failOnViolations) {
  process.exit(1);
} else {
  // Non-blocking: warn but don't break CI.
  process.exit(0);
}
