#!/usr/bin/env node
/**
 * Lint rule: every .md file added to .cleo/agent-outputs/ in a commit MUST
 * satisfy at least ONE of the three registration requirements:
 *
 *   (a) `cleo docs add` reference — the CLEO docs table has an entry for this
 *       file path (queried via `cleo docs list --task <id> --json`), OR
 *   (b) `cleo memory observe` — a BRAIN observation mentions this file path
 *       in its body (queried via `cleo memory find <relpath> --json`), OR
 *   (c) `@no-cleo-register` marker — the .md frontmatter (first 40 lines)
 *       contains the string `@no-cleo-register` to explicitly opt out.
 *
 * This prevents future markdown debt accumulation in agent-outputs/ by
 * requiring every generated report to be indexed in the CLEO knowledge graph
 * or explicitly annotated as intentionally unregistered.
 *
 * Usage:
 *   node scripts/lint-agent-outputs-registration.mjs                     # warn-only (exit 0)
 *   node scripts/lint-agent-outputs-registration.mjs --severity error    # CI gate (exit 1)
 *   node scripts/lint-agent-outputs-registration.mjs --since main        # only newly added files
 *   node scripts/lint-agent-outputs-registration.mjs --json              # machine-readable output
 *   node scripts/lint-agent-outputs-registration.mjs --help              # print usage
 *
 * Project-agnostic: runs in any `cleo init` repo. Reads `.cleo/agent-outputs/`
 * relative to process.cwd() (override with --reports-dir).
 *
 * Exit codes:
 *   0 — all files registered, or --severity warn
 *   1 — unregistered files found and --severity error
 *   2 — usage / runtime error
 *
 * @task T1617
 * @epic T1611
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

// ============================================================================
// Constants
// ============================================================================

/** Default directory (relative to cwd) containing markdown agent reports. */
const REPORTS_DIR = '.cleo/agent-outputs';

/** Markdown file extension. */
const MD_EXT = '.md';

/**
 * Opt-out marker. When this string appears in the first 40 lines of a .md
 * file (typically in YAML frontmatter), the file is exempt from registration.
 */
const NO_REGISTER_MARKER = '@no-cleo-register';

/** Number of leading lines to scan for the opt-out marker. */
const FRONTMATTER_SCAN_LINES = 40;

// ============================================================================
// CLI argument parsing
// ============================================================================

/**
 * @typedef {object} Config
 * @property {'warn' | 'error'} severity
 * @property {string[]} ignore
 * @property {string | null} since
 * @property {boolean} json
 * @property {string} reportsDir
 * @property {string} cwd
 * @property {string} cleoBin
 * @property {boolean} help
 */

/**
 * Parse argv into a structured config object.
 *
 * @param {string[]} argv - Process argv slice (node + script already excluded).
 * @returns {Config}
 */
export function parseArgs(argv) {
  /** @type {Config} */
  const config = {
    severity: 'warn',
    ignore: [],
    since: null,
    json: false,
    reportsDir: REPORTS_DIR,
    cwd: process.cwd(),
    cleoBin: process.env.CLEO_BIN || 'cleo',
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      config.help = true;
    } else if (arg === '--severity') {
      const next = argv[++i];
      if (next !== 'warn' && next !== 'error') {
        throw new Error(`--severity must be 'warn' or 'error', got: ${String(next)}`);
      }
      config.severity = next;
    } else if (arg === '--ignore') {
      const next = argv[++i];
      if (typeof next !== 'string') {
        throw new Error('--ignore requires a comma-separated value');
      }
      config.ignore = next
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    } else if (arg === '--since') {
      const next = argv[++i];
      if (typeof next !== 'string' || next.length === 0) {
        throw new Error('--since requires a git ref');
      }
      config.since = next;
    } else if (arg === '--json') {
      config.json = true;
    } else if (arg === '--reports-dir') {
      const next = argv[++i];
      if (typeof next !== 'string' || next.length === 0) {
        throw new Error('--reports-dir requires a path');
      }
      config.reportsDir = next;
    } else if (arg === '--cwd') {
      const next = argv[++i];
      if (typeof next !== 'string' || next.length === 0) {
        throw new Error('--cwd requires a path');
      }
      config.cwd = resolve(next);
    } else if (arg === '--cleo-bin') {
      const next = argv[++i];
      if (typeof next !== 'string' || next.length === 0) {
        throw new Error('--cleo-bin requires a path');
      }
      config.cleoBin = next;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return config;
}

/**
 * Print help text to stdout.
 */
export function printHelp() {
  process.stdout.write(
    [
      'Usage: lint-agent-outputs-registration.mjs [options]',
      '',
      'For every .md file added to .cleo/agent-outputs/, require one of:',
      '  (a) cleo docs add reference for the file path',
      '  (b) cleo memory observe mentioning the file path',
      '  (c) @no-cleo-register marker in the file frontmatter (first 40 lines)',
      '',
      'Options:',
      '  --severity warn|error   Exit 0 (warn, default) or 1 (error) on violations',
      '  --ignore <patterns>     Comma-separated path substrings to skip',
      '  --since <git-ref>       Only check files added since this git ref',
      '  --json                  Emit JSON report to stdout instead of human text',
      '  --reports-dir <path>    Override default .cleo/agent-outputs',
      '  --cwd <path>            Run as if cwd were <path>',
      '  --cleo-bin <path>       Override `cleo` CLI binary (default: $PATH)',
      '  --help, -h              Show this help',
      '',
    ].join('\n'),
  );
}

// ============================================================================
// File discovery
// ============================================================================

/**
 * Recursively collect all *.md files under `dir`. Returns absolute paths.
 *
 * @param {string} dir - Absolute directory path to walk.
 * @returns {string[]} Sorted absolute paths to *.md files.
 */
export function collectMarkdownFiles(dir) {
  /** @type {string[]} */
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err && /** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') {
      return out;
    }
    throw err;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectMarkdownFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(MD_EXT)) {
      out.push(full);
    }
  }
  return out.sort();
}

/**
 * Filter file list to only those ADDED (not just modified) since `gitRef`.
 * Uses `git diff --name-only --diff-filter=A` so existing files that are
 * merely edited are not flagged. Falls back to the full list on git failure.
 *
 * @param {string[]} files - Absolute file paths.
 * @param {string} gitRef - Git ref to diff against (e.g. `main`, `HEAD~1`).
 * @param {string} cwd - Working directory (inside the git repo).
 * @returns {string[]} Filtered absolute paths (sorted).
 */
export function filterAddedSince(files, gitRef, cwd) {
  const result = spawnSync('git', ['diff', '--name-only', '--diff-filter=A', `${gitRef}...HEAD`], {
    cwd,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    // git unavailable or bad ref — fall back to all files
    return files;
  }
  const added = new Set(
    result.stdout
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((rel) => resolve(cwd, rel)),
  );
  return files.filter((abs) => added.has(abs));
}

// ============================================================================
// Registration checks
// ============================================================================

/**
 * Check whether the file contains the `@no-cleo-register` opt-out marker in
 * its frontmatter (first FRONTMATTER_SCAN_LINES lines).
 *
 * @param {string} absPath - Absolute path to the .md file.
 * @returns {boolean}
 */
export function hasOptOutMarker(absPath) {
  let content;
  try {
    content = readFileSync(absPath, 'utf8');
  } catch {
    return false;
  }
  const lines = content.split('\n').slice(0, FRONTMATTER_SCAN_LINES);
  return lines.some((line) => line.includes(NO_REGISTER_MARKER));
}

/**
 * @typedef {object} DocsListResult
 * @property {boolean} found
 * @property {string} [error]
 */

/**
 * Extract a task ID (e.g. `T1617`) from an agent-output filename.
 * Matches the leading `T<digits>` or `T-<slug>-<digits>` token.
 *
 * @param {string} basename - Filename, e.g. `T1617-foo-bar.md`.
 * @returns {string | null}
 */
export function extractTaskIdFromFilename(basename) {
  const match = basename.match(/^(T-?[A-Za-z0-9_-]*\d[A-Za-z0-9_-]*?)[-_.]/);
  if (match) return match[1];
  // Also handle bare `T1617.md`
  const bare = basename.match(/^(T-?[A-Za-z0-9_-]*\d[A-Za-z0-9_-]*)\.md$/i);
  if (bare) return bare[1];
  return null;
}

/**
 * Query `cleo docs list --task <id> --json` and check if `relPath` appears.
 *
 * `cleo docs list` requires a `--task` filter. We derive the task ID from the
 * filename (e.g. `T1617-foo.md` → `T1617`). If no task ID can be derived,
 * we treat the docs check as not-found and fall through to memory/marker.
 *
 * When the cleo binary is absent or errors, we treat as not-found (non-fatal)
 * so that environments without cleo installed (e.g. CI runners) still work —
 * the only hard requirement in those contexts is the marker or memory check.
 *
 * @param {string} relPath - Path relative to cwd (e.g. `.cleo/agent-outputs/T123-foo.md`).
 * @param {string} cleoBin - Path to cleo CLI binary.
 * @param {string} cwd - Working directory.
 * @returns {DocsListResult}
 */
export function checkDocsRegistration(relPath, cleoBin, cwd) {
  const basename = relPath.split('/').pop() ?? relPath;
  const taskId = extractTaskIdFromFilename(basename);
  if (!taskId) {
    return { found: false, error: `cannot derive task ID from filename: ${basename}` };
  }

  const result = spawnSync(cleoBin, ['docs', 'list', '--task', taskId, '--json'], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 10_000,
  });

  // Binary not found (ENOENT) or timed out — treat as not-found, not error
  if (result.error) {
    const code = /** @type {NodeJS.ErrnoException} */ (result.error).code;
    if (code === 'ENOENT') return { found: false };
    return { found: false, error: `cleo spawn error: ${result.error.message}` };
  }

  if (result.status !== 0 && result.stdout.trim().length === 0) {
    return { found: false, error: `cleo docs list exited ${result.status ?? 'null'}` };
  }
  try {
    const lines = result.stdout.split('\n').filter((l) => l.trim().startsWith('{'));
    const jsonLine = lines[lines.length - 1] ?? result.stdout;
    const parsed = JSON.parse(jsonLine);
    if (parsed?.success !== true) {
      return {
        found: false,
        error: parsed?.error?.message ?? 'cleo docs list returned non-success envelope',
      };
    }
    const docs = Array.isArray(parsed.data?.docs) ? parsed.data.docs : [];
    const found = docs.some((doc) => {
      const docPath = String(doc.url ?? doc.path ?? doc.file ?? '');
      return docPath.includes(relPath) || docPath.includes(basename);
    });
    return { found };
  } catch (err) {
    return {
      found: false,
      error: `JSON parse failed: ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`,
    };
  }
}

/**
 * @typedef {object} MemoryFindResult
 * @property {boolean} found
 * @property {string} [error]
 */

/**
 * Query `cleo memory find <query> --json` to check if any BRAIN observation
 * mentions `relPath` in its body.
 *
 * @param {string} relPath - Path relative to cwd.
 * @param {string} cleoBin - Path to cleo CLI binary.
 * @param {string} cwd - Working directory.
 * @returns {MemoryFindResult}
 */
export function checkMemoryRegistration(relPath, cleoBin, cwd) {
  // Use the filename as the search query — most likely to match
  const query = relPath.split('/').pop() ?? relPath;
  const result = spawnSync(cleoBin, ['memory', 'find', query, '--json'], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 10_000,
  });
  // Binary not found — treat as not-found, not error
  if (result.error) {
    const code = /** @type {NodeJS.ErrnoException} */ (result.error).code;
    if (code === 'ENOENT') return { found: false };
    return { found: false, error: `cleo spawn error: ${result.error.message}` };
  }
  if (result.status !== 0 && result.stdout.trim().length === 0) {
    return { found: false, error: `cleo memory find exited ${result.status ?? 'null'}` };
  }
  try {
    const lines = result.stdout.split('\n').filter((l) => l.trim().startsWith('{'));
    const jsonLine = lines[lines.length - 1] ?? result.stdout;
    const parsed = JSON.parse(jsonLine);
    if (parsed?.success !== true) {
      return {
        found: false,
        error: parsed?.error?.message ?? 'cleo memory find returned non-success envelope',
      };
    }
    const memories = Array.isArray(parsed.data?.memories)
      ? parsed.data.memories
      : Array.isArray(parsed.data?.results)
        ? parsed.data.results
        : [];
    const found = memories.some((mem) => {
      const body = String(mem.body ?? mem.content ?? mem.text ?? '');
      return body.includes(relPath) || body.includes(query);
    });
    return { found };
  } catch (err) {
    return {
      found: false,
      error: `JSON parse failed: ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`,
    };
  }
}

// ============================================================================
// Violation types
// ============================================================================

/**
 * @typedef {object} RegistrationStatus
 * @property {string} file - Absolute path to the .md file.
 * @property {string} relPath - Path relative to cwd.
 * @property {boolean} optedOut - Has `@no-cleo-register` marker.
 * @property {boolean} docsRegistered - Found in `cleo docs list`.
 * @property {boolean} memoryRegistered - Found in `cleo memory find`.
 * @property {boolean} registered - True if ANY registration method succeeded.
 * @property {string} method - Which method satisfied registration (or 'none').
 * @property {string[]} errors - Errors encountered while checking (non-fatal).
 */

/**
 * Determine the registration status for a single .md file.
 *
 * @param {string} absPath - Absolute path to the .md file.
 * @param {string} cwd - Working directory.
 * @param {string} cleoBin - Path to cleo CLI binary.
 * @returns {RegistrationStatus}
 */
export function checkRegistration(absPath, cwd, cleoBin) {
  const relPath = relative(cwd, absPath);
  /** @type {string[]} */
  const errors = [];

  // (c) opt-out marker — cheapest check first
  if (hasOptOutMarker(absPath)) {
    return {
      file: absPath,
      relPath,
      optedOut: true,
      docsRegistered: false,
      memoryRegistered: false,
      registered: true,
      method: 'opt-out',
      errors,
    };
  }

  // (a) cleo docs add reference
  const docsResult = checkDocsRegistration(relPath, cleoBin, cwd);
  if (docsResult.error) errors.push(docsResult.error);

  if (docsResult.found) {
    return {
      file: absPath,
      relPath,
      optedOut: false,
      docsRegistered: true,
      memoryRegistered: false,
      registered: true,
      method: 'docs',
      errors,
    };
  }

  // (b) cleo memory observe mentioning file path
  const memResult = checkMemoryRegistration(relPath, cleoBin, cwd);
  if (memResult.error) errors.push(memResult.error);

  if (memResult.found) {
    return {
      file: absPath,
      relPath,
      optedOut: false,
      docsRegistered: false,
      memoryRegistered: true,
      registered: true,
      method: 'memory',
      errors,
    };
  }

  return {
    file: absPath,
    relPath,
    optedOut: false,
    docsRegistered: false,
    memoryRegistered: false,
    registered: false,
    method: 'none',
    errors,
  };
}

// ============================================================================
// Top-level pipeline
// ============================================================================

/**
 * @typedef {object} LintResult
 * @property {string[]} files - All .md files scanned.
 * @property {RegistrationStatus[]} statuses - Per-file registration status.
 * @property {RegistrationStatus[]} violations - Files that are NOT registered.
 * @property {RegistrationStatus[]} registered - Files that ARE registered.
 * @property {string} reportsDir - Absolute path to the reports directory.
 */

/**
 * Run the linter end-to-end.
 *
 * @param {{
 *   cwd: string,
 *   reportsDir: string,
 *   ignore: string[],
 *   since: string | null,
 *   cleoBin: string,
 * }} opts
 * @returns {LintResult}
 */
export function lint(opts) {
  const reportsDirAbs = resolve(opts.cwd, opts.reportsDir);
  /** @type {string[]} */
  let files = [];

  if (existsSync(reportsDirAbs)) {
    try {
      const stat = statSync(reportsDirAbs);
      if (stat.isDirectory()) {
        files = collectMarkdownFiles(reportsDirAbs);
      }
    } catch (err) {
      if (!err || /** @type {NodeJS.ErrnoException} */ (err).code !== 'ENOENT') {
        throw err;
      }
    }
  }

  if (opts.since) {
    files = filterAddedSince(files, opts.since, opts.cwd);
  }

  if (opts.ignore.length > 0) {
    files = files.filter((f) => {
      const rel = relative(opts.cwd, f);
      return !opts.ignore.some((pat) => rel.includes(pat));
    });
  }

  /** @type {RegistrationStatus[]} */
  const statuses = files.map((absPath) => checkRegistration(absPath, opts.cwd, opts.cleoBin));

  return {
    files,
    statuses,
    violations: statuses.filter((s) => !s.registered),
    registered: statuses.filter((s) => s.registered),
    reportsDir: reportsDirAbs,
  };
}

// ============================================================================
// Output formatting
// ============================================================================

/**
 * Format a single violation as a human-readable block.
 *
 * @param {RegistrationStatus} s
 * @returns {string}
 */
function formatViolationHuman(s) {
  const lines = [
    `  ${s.relPath}`,
    '    Fix: choose one of:',
    '      (a) cleo docs add <taskId> <file>    — attach file to a task',
    '      (b) cleo memory observe "<text mentioning path>" --title "<t>"',
    '      (c) add "@no-cleo-register" to the file frontmatter (first 40 lines)',
  ];
  if (s.errors.length > 0) {
    lines.push(`    Warnings: ${s.errors.join('; ')}`);
  }
  return lines.join('\n');
}

/**
 * Emit the lint report to stdout.
 *
 * @param {LintResult} result
 * @param {{ json: boolean, cwd: string, severity: 'warn' | 'error' }} opts
 */
function emitReport(result, opts) {
  if (opts.json) {
    const payload = {
      generatedAt: new Date().toISOString(),
      reportsDir: result.reportsDir,
      summary: {
        filesScanned: result.files.length,
        registered: result.registered.length,
        violations: result.violations.length,
        severity: opts.severity,
      },
      violations: result.violations.map((s) => ({
        file: s.file,
        relPath: s.relPath,
        docsRegistered: s.docsRegistered,
        memoryRegistered: s.memoryRegistered,
        optedOut: s.optedOut,
        errors: s.errors,
      })),
      registered: result.registered.map((s) => ({
        relPath: s.relPath,
        method: s.method,
      })),
    };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }

  if (result.violations.length === 0) {
    process.stdout.write(
      `agent-outputs-registration: OK — ${result.files.length} file(s) all registered.\n`,
    );
    return;
  }

  process.stdout.write(
    `agent-outputs-registration: ${result.violations.length} unregistered file(s) in ${result.files.length} scanned:\n\n`,
  );
  for (const s of result.violations) {
    process.stdout.write(`${formatViolationHuman(s)}\n\n`);
  }
  process.stdout.write(
    `Each .md added to agent-outputs/ must be registered via one of:\n` +
      `  (a) cleo docs add <taskId> <file>\n` +
      `  (b) cleo memory observe "<text>" --title "<t>"  (body must mention file path)\n` +
      `  (c) @no-cleo-register in frontmatter (first 40 lines)\n\n` +
      `severity=${opts.severity} → exit ${opts.severity === 'error' ? 1 : 0}\n`,
  );
}

// ============================================================================
// Entry point
// ============================================================================

/**
 * Return true when this module is the direct entry point (not imported).
 *
 * @returns {boolean}
 */
function isMain() {
  const invoked = process.argv[1];
  if (!invoked) return false;
  try {
    const url = new URL(import.meta.url);
    const path = url.pathname;
    return resolve(path) === resolve(invoked);
  } catch {
    return false;
  }
}

if (isMain()) {
  let config;
  try {
    config = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    printHelp();
    process.exit(2);
  }
  if (config.help) {
    printHelp();
    process.exit(0);
  }
  let result;
  try {
    result = lint({
      cwd: config.cwd,
      reportsDir: config.reportsDir,
      ignore: config.ignore,
      since: config.since,
      cleoBin: config.cleoBin,
    });
  } catch (err) {
    process.stderr.write(`error: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(2);
  }
  emitReport(result, { json: config.json, cwd: config.cwd, severity: config.severity });
  if (result.violations.length > 0 && config.severity === 'error') {
    process.exit(1);
  }
  process.exit(0);
}
