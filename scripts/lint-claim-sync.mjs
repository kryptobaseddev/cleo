#!/usr/bin/env node
/**
 * Claim-sync linter — detect markdown agent-output reports that claim a CLEO
 * task is "shipped/done/complete/merged/landed/fixed" while `cleo show <id>`
 * still reports the task as `pending` (or with failed verification gates).
 *
 * Catches the failure mode this session uncovered: predecessor handoffs that
 * declared work complete while tasks.db said otherwise. Project-agnostic —
 * runs in any `cleo init` repo. Reads `.cleo/agent-outputs/**\/*.md` relative
 * to `process.cwd()` and queries `cleo show <id> --json` via child_process.
 *
 * Usage:
 *   node scripts/lint-claim-sync.mjs                       # warn-only (exit 0)
 *   node scripts/lint-claim-sync.mjs --severity error      # CI gate (exit 1)
 *   node scripts/lint-claim-sync.mjs --since main          # incremental
 *   node scripts/lint-claim-sync.mjs --ignore foo,bar      # skip patterns
 *   node scripts/lint-claim-sync.mjs --json                # machine-readable
 *
 * Output (default human): one line per mismatch + summary footer.
 * Output (--json):        `{ generatedAt, mismatches: [...], summary: {...} }`.
 *
 * Filters (skip line as false-positive when):
 *   - Line begins with quote/table marker (`>`, `|`)
 *   - Line contains `⚠ UNVERIFIED`, `[unverified]`, `(unverified)`
 *   - Line has uncertainty markers near the claim:
 *     `would be`, `should be`, `claimed`, `predecessor said/claimed`,
 *     `allegedly`, `supposedly`, `if true`
 *
 * Exit codes:
 *   0 — no mismatches, or `--severity warn`
 *   1 — mismatches found and `--severity error`
 *   2 — usage / runtime error
 *
 * @task T1598
 * @epic T1586
 */

import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

// ============================================================================
// Configuration
// ============================================================================

/** Directory (relative to cwd) containing markdown agent reports. */
const REPORTS_DIR = '.cleo/agent-outputs';

/** Markdown file extension. */
const MD_EXT = '.md';

/**
 * Status verbs that, when paired with a task ID on the same line, assert that
 * the task is finished. Matches are case-insensitive with word boundaries.
 */
const COMPLETION_KEYWORDS = [
  'shipped',
  'done',
  'complete',
  'completed',
  'merged',
  'landed',
  'fixed',
  'closed',
  'finished',
  'delivered',
  'resolved',
];

/** Visual completion glyphs that, when paired with a task ID, assert done-ness. */
const COMPLETION_GLYPHS = ['✅', '✓', '☑'];

/** Phrases (case-insensitive) that also assert completion. */
const COMPLETION_PHRASES = ['100%', 'feature complete', 'feature-complete'];

/**
 * Uncertainty markers that demote a "claim" line to a hedged statement.
 * Lines matching any of these are NOT treated as assertions of completion.
 */
const UNCERTAINTY_MARKERS = [
  /\bwould be\b/i,
  /\bshould be\b/i,
  /\bclaimed\b/i,
  /\bpredecessor (said|claimed|reported|asserted)\b/i,
  /\ballegedly\b/i,
  /\bsupposedly\b/i,
  /\bif true\b/i,
  /\bunverified\b/i,
  /⚠\s*UNVERIFIED/i,
  /\[unverified\]/i,
  /\(unverified\)/i,
];

/**
 * Quote / table prefixes that we skip — these typically reference past state
 * or copy other agents' words rather than asserting completion ourselves.
 */
const QUOTE_PREFIX_RE = /^\s*(?:>|\|)/;

/**
 * Task ID pattern. Captures both `T123` numeric IDs and longer
 * `T-NAME-1`-style identifiers. Word-anchored so `XT123` does not match.
 */
const TASK_ID_RE = /\bT-?[A-Za-z0-9_-]*\d[A-Za-z0-9_-]*\b/g;

// ============================================================================
// CLI argument parsing
// ============================================================================

/**
 * Parse argv into a structured config object.
 *
 * @param {string[]} argv - Process argv slice (already excludes node + script).
 * @returns {{severity: 'warn' | 'error', ignore: string[], since: string | null,
 *            json: boolean, reportsDir: string, cwd: string,
 *            cleoBin: string, help: boolean}}
 */
export function parseArgs(argv) {
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
 * Print --help text to stdout.
 */
export function printHelp() {
  process.stdout.write(
    [
      'Usage: lint-claim-sync.mjs [options]',
      '',
      'Scan .cleo/agent-outputs/**/*.md for completion claims that disagree with',
      'tasks.db state (queried via `cleo show <id> --json`).',
      '',
      'Options:',
      '  --severity warn|error   Exit 0 (warn, default) or 1 (error) on mismatch',
      '  --ignore <patterns>     Comma-separated path substrings to skip',
      '  --since <git-ref>       Only check files changed since this git ref',
      '  --json                  Emit JSON report to stdout instead of text',
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
 * Recursively collect markdown files under `dir`. Returns absolute paths.
 *
 * @param {string} dir - Absolute directory path to walk.
 * @returns {string[]} Absolute paths to *.md files (sorted).
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
 * Filter file list to the subset modified since `gitRef`. Falls back to the
 * unfiltered list if git is unavailable or the ref is unknown.
 *
 * @param {string[]} files - Absolute file paths.
 * @param {string} gitRef - Git ref to diff against (e.g. `main`, `HEAD~3`).
 * @param {string} cwd - Working directory (must be inside the git repo).
 * @returns {string[]} Filtered absolute paths (sorted).
 */
export function filterSince(files, gitRef, cwd) {
  const result = spawnSync('git', ['diff', '--name-only', `${gitRef}...HEAD`], {
    cwd,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    return files;
  }
  const changed = new Set(
    result.stdout
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((rel) => resolve(cwd, rel)),
  );
  return files.filter((abs) => changed.has(abs));
}

// ============================================================================
// Claim extraction
// ============================================================================

/**
 * @typedef {object} Claim
 * @property {string} taskId    - Task ID referenced on the line (e.g. `T1598`).
 * @property {string} file      - Absolute path to the markdown source.
 * @property {number} line      - 1-indexed line number of the claim.
 * @property {string} keyword   - Keyword/glyph/phrase that triggered the match.
 * @property {string} text      - The full line text (trimmed, max 200 chars).
 */

/**
 * Test whether a line asserts task completion. Returns the matching keyword
 * (lower-cased) or null if the line is hedged, quoted, or non-assertive.
 *
 * @param {string} line - Raw line content.
 * @returns {string | null}
 */
export function detectCompletionKeyword(line) {
  if (QUOTE_PREFIX_RE.test(line)) return null;
  for (const re of UNCERTAINTY_MARKERS) {
    if (re.test(line)) return null;
  }
  const lower = line.toLowerCase();
  for (const kw of COMPLETION_KEYWORDS) {
    // word-boundary match, case-insensitive
    const re = new RegExp(`\\b${kw}\\b`, 'i');
    if (re.test(line)) return kw;
  }
  for (const glyph of COMPLETION_GLYPHS) {
    if (line.includes(glyph)) return glyph;
  }
  for (const phrase of COMPLETION_PHRASES) {
    if (lower.includes(phrase)) return phrase;
  }
  return null;
}

/**
 * Extract every `(taskId, line)` claim pair from a markdown file. A claim
 * exists when a single line contains BOTH a task-ID match AND a completion
 * keyword/glyph/phrase, and the line is not filtered out by uncertainty or
 * quote markers.
 *
 * @param {string} file - Absolute path to the markdown file.
 * @returns {Claim[]}
 */
export function extractClaimsFromFile(file) {
  /** @type {Claim[]} */
  const claims = [];
  const content = readFileSync(file, 'utf8');
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const keyword = detectCompletionKeyword(line);
    if (!keyword) continue;
    const ids = line.match(TASK_ID_RE);
    if (!ids) continue;
    const seen = new Set();
    for (const raw of ids) {
      // Normalize: keep canonical T<num> form by stripping trailing punctuation.
      const taskId = raw.replace(/[^A-Za-z0-9_-]+$/, '');
      // Reject pure numeric without T-prefix anchor.
      if (!/^T/i.test(taskId)) continue;
      // Reject ambiguous one-letter Ts (e.g. T as a column header).
      if (taskId.length < 2) continue;
      if (seen.has(taskId)) continue;
      seen.add(taskId);
      claims.push({
        taskId,
        file,
        line: i + 1,
        keyword,
        text: line.trim().slice(0, 200),
      });
    }
  }
  return claims;
}

// ============================================================================
// CLEO state lookup
// ============================================================================

/**
 * @typedef {object} TaskState
 * @property {string}  id
 * @property {string}  status
 * @property {boolean} verificationPassed
 * @property {boolean} found
 * @property {string} [error]
 */

/**
 * Query `cleo show <id> --json` and parse the result. Cached per process call
 * via the shared `cache` Map argument (caller-owned to keep this fn pure).
 *
 * @param {string} id - Task ID.
 * @param {Map<string, TaskState>} cache - In-memory result cache.
 * @param {string} cleoBin - Path to the cleo CLI binary.
 * @param {string} cwd - Working directory.
 * @returns {TaskState}
 */
export function fetchTaskState(id, cache, cleoBin, cwd) {
  const cached = cache.get(id);
  if (cached) return cached;
  const result = spawnSync(cleoBin, ['show', id, '--json'], {
    cwd,
    encoding: 'utf8',
    // cleo CLI is sometimes verbose; cap output to keep memory tidy.
    maxBuffer: 16 * 1024 * 1024,
  });
  /** @type {TaskState} */
  let state;
  if (result.status !== 0 && result.stdout.trim().length === 0) {
    state = {
      id,
      status: 'unknown',
      verificationPassed: false,
      found: false,
      error: `cleo show ${id} exited ${result.status ?? 'null'}: ${result.stderr.trim().slice(0, 200)}`,
    };
    cache.set(id, state);
    return state;
  }
  try {
    // cleo prints deprecation warnings on stderr; stdout is the JSON envelope.
    // Defensive: pick the last line that begins with `{`.
    const lines = result.stdout.split('\n').filter((l) => l.trim().startsWith('{'));
    const jsonLine = lines[lines.length - 1] ?? result.stdout;
    const parsed = JSON.parse(jsonLine);
    if (parsed?.success === true && parsed.data?.task) {
      const task = parsed.data.task;
      state = {
        id,
        status: String(task.status ?? 'unknown'),
        verificationPassed: Boolean(task.verification?.passed),
        found: true,
      };
    } else {
      state = {
        id,
        status: 'unknown',
        verificationPassed: false,
        found: false,
        error: parsed?.error?.message ?? 'cleo show returned non-success envelope',
      };
    }
  } catch (err) {
    state = {
      id,
      status: 'unknown',
      verificationPassed: false,
      found: false,
      error: `JSON parse failed: ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`,
    };
  }
  cache.set(id, state);
  return state;
}

// ============================================================================
// Mismatch evaluation
// ============================================================================

/**
 * @typedef {Claim & {
 *   actualStatus: string,
 *   actualVerification: boolean,
 *   mismatch: boolean,
 *   reason: string,
 * }} Mismatch
 */

/**
 * Decide whether a completion claim disagrees with `cleo show` state.
 *
 * Mismatch when:
 *   - Task is not found in tasks.db (claim references a non-existent ID), OR
 *   - Task status is not `done` AND verification.passed is false.
 *
 * Sole-status `done` with failing verification is treated as a non-mismatch
 * because the operator has marked the task done — verification gates are an
 * orthogonal concern surfaced via `cleo verify`, not this linter.
 *
 * @param {Claim} claim
 * @param {TaskState} state
 * @returns {Mismatch}
 */
export function evaluateClaim(claim, state) {
  if (!state.found) {
    return {
      ...claim,
      actualStatus: 'not-found',
      actualVerification: false,
      mismatch: true,
      reason: state.error ?? `task ${claim.taskId} not found in tasks.db`,
    };
  }
  // Treat `done`, `completed`, `archived` as completed terminal states.
  const completedStates = new Set(['done', 'completed', 'archived', 'closed']);
  const isComplete = completedStates.has(state.status.toLowerCase());
  const mismatch = !isComplete;
  return {
    ...claim,
    actualStatus: state.status,
    actualVerification: state.verificationPassed,
    mismatch,
    reason: mismatch
      ? `claim says "${claim.keyword}" but cleo status is "${state.status}"`
      : 'state matches claim',
  };
}

// ============================================================================
// Top-level pipeline
// ============================================================================

/**
 * Run the linter end-to-end against a directory tree.
 *
 * @param {{
 *   cwd: string,
 *   reportsDir: string,
 *   ignore: string[],
 *   since: string | null,
 *   cleoBin: string,
 * }} opts
 * @returns {{
 *   files: string[],
 *   claims: Claim[],
 *   mismatches: Mismatch[],
 *   matched: Mismatch[],
 *   reportsDir: string,
 * }}
 */
export function lint(opts) {
  const reportsDirAbs = resolve(opts.cwd, opts.reportsDir);
  let files;
  try {
    const stat = statSync(reportsDirAbs);
    if (!stat.isDirectory()) {
      files = [];
    } else {
      files = collectMarkdownFiles(reportsDirAbs);
    }
  } catch (err) {
    if (err && /** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') {
      files = [];
    } else {
      throw err;
    }
  }
  if (opts.since) {
    files = filterSince(files, opts.since, opts.cwd);
  }
  if (opts.ignore.length > 0) {
    files = files.filter((f) => {
      const rel = relative(opts.cwd, f);
      return !opts.ignore.some((pat) => rel.includes(pat));
    });
  }
  /** @type {Claim[]} */
  const claims = [];
  for (const file of files) {
    claims.push(...extractClaimsFromFile(file));
  }
  /** @type {Map<string, TaskState>} */
  const cache = new Map();
  /** @type {Mismatch[]} */
  const evaluated = claims.map((c) =>
    evaluateClaim(c, fetchTaskState(c.taskId, cache, opts.cleoBin, opts.cwd)),
  );
  return {
    files,
    claims,
    mismatches: evaluated.filter((e) => e.mismatch),
    matched: evaluated.filter((e) => !e.mismatch),
    reportsDir: reportsDirAbs,
  };
}

// ============================================================================
// Output formatting
// ============================================================================

/**
 * Render a single mismatch as a human-readable line.
 *
 * @param {Mismatch} m
 * @param {string} cwd
 * @returns {string}
 */
function formatMismatchHuman(m, cwd) {
  const rel = relative(cwd, m.file);
  return `${rel}:${m.line}  [${m.taskId}]  ${m.reason}\n  > ${m.text}`;
}

/**
 * Print the report to stdout in human or JSON form.
 *
 * @param {ReturnType<typeof lint>} result
 * @param {{ json: boolean, cwd: string, severity: 'warn' | 'error' }} opts
 */
function emitReport(result, opts) {
  if (opts.json) {
    const payload = {
      generatedAt: new Date().toISOString(),
      reportsDir: result.reportsDir,
      summary: {
        filesScanned: result.files.length,
        claims: result.claims.length,
        mismatches: result.mismatches.length,
        severity: opts.severity,
      },
      mismatches: result.mismatches.map((m) => ({
        taskId: m.taskId,
        file: m.file,
        line: m.line,
        claim: m.text,
        keyword: m.keyword,
        actualStatus: m.actualStatus,
        actualVerification: m.actualVerification,
        mismatch: m.mismatch,
        reason: m.reason,
      })),
    };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  if (result.mismatches.length === 0) {
    process.stdout.write(
      `claim-sync: OK — ${result.claims.length} claim(s) across ${result.files.length} file(s) all consistent.\n`,
    );
    return;
  }
  process.stdout.write(
    `claim-sync: ${result.mismatches.length} mismatch(es) in ${result.files.length} file(s):\n\n`,
  );
  for (const m of result.mismatches) {
    process.stdout.write(`${formatMismatchHuman(m, opts.cwd)}\n\n`);
  }
  process.stdout.write(`severity=${opts.severity} → exit ${opts.severity === 'error' ? 1 : 0}\n`);
}

// ============================================================================
// Entry point
// ============================================================================

/**
 * Whether the current module is executing as the main script (vs imported).
 *
 * @returns {boolean}
 */
function isMain() {
  // Node ESM: import.meta.url === pathToFileURL(process.argv[1]).href
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
  if (result.mismatches.length > 0 && config.severity === 'error') {
    process.exit(1);
  }
  process.exit(0);
}
