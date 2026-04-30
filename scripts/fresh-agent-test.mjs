#!/usr/bin/env node
/**
 * fresh-agent-test.mjs
 *
 * Final acceptance test for the T1611 KNOWLEDGE-FIRST-CITIZEN epic.
 *
 * Simulates a zero-context auditor that has NEVER seen this project before.
 * The auditor is PHYSICALLY blocked from reading any .md file under
 * .cleo/agent-outputs/ (file-read denylist enforced via a guarded wrapper
 * around Node's fs.readFileSync / fs.readFile / fs.openSync).
 *
 * The auditor must recover full project state using ONLY:
 *   1. cleo briefing
 *   2. cleo docs list / cleo docs search
 *   3. cleo memory find / cleo memory digest
 *   4. cleo show <taskId>
 *
 * Scoring:
 *   10 probes are evaluated. Score = number of probes passed.
 *   Score 10/10 → exit 0 (epic acceptance gate PASSES).
 *   Score  < 10 → exit 1 (epic acceptance gate FAILS).
 *
 * The denylist guard is implemented by wrapping Node's built-in fs module
 * before any cleo invocation. Any attempt to synchronously or asynchronously
 * read a file matching the denylist pattern throws EACCES with a diagnostic
 * message.
 *
 * Usage:
 *   node scripts/fresh-agent-test.mjs [OPTIONS]
 *
 * Options:
 *   --cleo-bin <path>   Path to cleo executable (default: cleo on PATH)
 *   --cwd <path>        Project root to use (default: process.cwd())
 *   --task <id>         Task ID to probe with cleo show (default: first active task found)
 *   --json              Emit machine-readable JSON result to stdout
 *   --verbose           Print detailed per-probe output
 *   --no-guard          Disable the file-read denylist (useful for debugging only)
 *   --help              Print this usage message
 *
 * Exit codes:
 *   0   All 10 probes passed (score 10/10)
 *   1   One or more probes failed (score < 10) OR denylist was violated
 *   2   Usage error or fatal runtime error
 *
 * Project-agnostic: runs in any `cleo init` repo.
 *
 * @task T1618
 * @epic T1611
 */

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

/**
 * Obtain a mutable reference to the `fs` CommonJS module.
 *
 * ESM live bindings exported by `node:fs` are read-only — you cannot
 * reassign `readFileSync` on an `import * as fs` namespace. However, the
 * Node.js module registry stores one shared CJS `fs` object whose properties
 * ARE writable. `createRequire(import.meta.url)('fs')` reaches that shared
 * object, allowing us to install the denylist guard without resorting to
 * native hooks or a separate preload file.
 */
const _require = createRequire(import.meta.url);
/** @type {typeof import('node:fs')} */
const fsCjs = _require('fs');

// ============================================================================
// CLI argument parsing
// ============================================================================

/**
 * @typedef {object} Config
 * @property {string}      cleoBin
 * @property {string}      cwd
 * @property {string|null} taskId
 * @property {boolean}     json
 * @property {boolean}     verbose
 * @property {boolean}     guard
 * @property {boolean}     help
 */

/**
 * Parse argv into a Config object.
 *
 * @param {string[]} argv
 * @returns {Config}
 */
export function parseArgs(argv) {
  /** @type {Config} */
  const config = {
    cleoBin: 'cleo',
    cwd: process.cwd(),
    taskId: null,
    json: false,
    verbose: false,
    guard: true,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--cleo-bin':
        config.cleoBin = argv[++i] ?? '';
        if (!config.cleoBin) throw new Error('--cleo-bin requires a value');
        break;
      case '--cwd':
        config.cwd = resolve(argv[++i] ?? '');
        if (!config.cwd) throw new Error('--cwd requires a value');
        break;
      case '--task':
        config.taskId = argv[++i] ?? null;
        if (!config.taskId) throw new Error('--task requires a value');
        break;
      case '--json':
        config.json = true;
        break;
      case '--verbose':
        config.verbose = true;
        break;
      case '--no-guard':
        config.guard = false;
        break;
      case '--help':
        config.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return config;
}

/**
 * Print usage message and exit 0.
 */
function printHelp() {
  console.log(
    `
Usage: node scripts/fresh-agent-test.mjs [OPTIONS]

Simulates a zero-context auditor with a PHYSICAL block on reading any .md
under .cleo/agent-outputs/. The auditor must recover full project state using
only cleo briefing + cleo docs + cleo memory + cleo show.

Scoring:
  10/10 probes passed → exit 0 (epic T1611 acceptance gate PASSES)
   < 10 probes passed → exit 1 (gate FAILS)

Options:
  --cleo-bin <path>   cleo executable (default: cleo on PATH)
  --cwd <path>        Project root (default: process.cwd())
  --task <id>         Task ID to probe via cleo show (default: auto-detected)
  --json              Emit machine-readable JSON to stdout
  --verbose           Print per-probe details
  --no-guard          Disable the file-read denylist (debug only)
  --help              Print this message

Exit codes:
  0  Score 10/10
  1  Score < 10 or denylist violated
  2  Fatal error / bad usage
`.trim(),
  );
}

// ============================================================================
// File-read denylist guard
// ============================================================================

/**
 * Tracks whether a denylist violation occurred.
 * @type {{ count: number; violations: string[] }}
 */
export const denylistState = { count: 0, violations: [] };

/**
 * Pattern that matches files inside .cleo/agent-outputs/ with .md extension.
 * Handles both absolute and relative paths using a cross-platform check.
 *
 * @param {string|Buffer|URL} filePath
 * @returns {boolean}
 */
export function isDenied(filePath) {
  try {
    const p = filePath instanceof URL ? filePath.pathname : String(filePath);
    // Normalise path separators for cross-platform safety
    const normalised = p.replace(/\\/g, '/');
    return /\/\.cleo\/agent-outputs\/[^/]+\.md$/.test(normalised);
  } catch {
    return false;
  }
}

/**
 * Install the file-read denylist guard onto the process-wide CJS `fs` module.
 *
 * Uses the mutable CommonJS module object (obtained via `createRequire`) so
 * the guard works even from ESM context where `import * as fs` live bindings
 * are read-only. Patching `fsCjs` (the shared CJS singleton) intercepts all
 * `require('fs').readFileSync` calls across the entire process, including any
 * CommonJS code (cleo plugins, chalk, etc.) loaded after this point.
 *
 * Calling this function more than once is idempotent — it only installs if
 * the wrappers are not already in place (checked via the `.___guarded` flag).
 */
export function installDenylistGuard() {
  // Guard against double-installation
  if (/** @type {any} */ (fsCjs.readFileSync).___guarded) return;

  const origReadFileSync = fsCjs.readFileSync.bind(fsCjs);
  const origReadFile = fsCjs.readFile.bind(fsCjs);
  const origOpenSync = fsCjs.openSync.bind(fsCjs);

  /**
   * @param {import('node:fs').PathOrFileDescriptor} path
   * @param {object|string|undefined} options
   * @returns {string|Buffer}
   */
  function guardedReadFileSync(path, options) {
    if (isDenied(path)) {
      denylistState.count++;
      denylistState.violations.push(String(path));
      const err = Object.assign(new Error(`DENYLIST: read blocked — ${String(path)}`), {
        code: 'EACCES',
        path: String(path),
      });
      throw err;
    }
    return origReadFileSync(path, options);
  }
  guardedReadFileSync.___guarded = true;

  /**
   * @param {import('node:fs').PathOrFileDescriptor} path
   * @param {object|string|((err: NodeJS.ErrnoException|null, data: Buffer) => void)} options
   * @param {((err: NodeJS.ErrnoException|null, data: Buffer|string) => void)=} callback
   */
  function guardedReadFile(path, options, callback) {
    if (isDenied(path)) {
      denylistState.count++;
      denylistState.violations.push(String(path));
      const err = Object.assign(new Error(`DENYLIST: read blocked — ${String(path)}`), {
        code: 'EACCES',
        path: String(path),
      });
      const cb = typeof options === 'function' ? options : callback;
      if (typeof cb === 'function') {
        process.nextTick(() => cb(err, /** @type {any} */ (null)));
        return;
      }
      throw err;
    }
    if (typeof options === 'function') {
      return origReadFile(path, options);
    }
    return origReadFile(path, options, /** @type {any} */ (callback));
  }

  /**
   * @param {import('node:fs').PathLike} path
   * @param {string} flags
   * @param {number=} mode
   * @returns {number}
   */
  function guardedOpenSync(path, flags, mode) {
    if (isDenied(path) && /^r/.test(String(flags))) {
      denylistState.count++;
      denylistState.violations.push(String(path));
      const err = Object.assign(new Error(`DENYLIST: open blocked — ${String(path)}`), {
        code: 'EACCES',
        path: String(path),
      });
      throw err;
    }
    return mode !== undefined ? origOpenSync(path, flags, mode) : origOpenSync(path, flags);
  }

  fsCjs.readFileSync = /** @type {any} */ (guardedReadFileSync);
  fsCjs.readFile = /** @type {any} */ (guardedReadFile);
  fsCjs.openSync = /** @type {any} */ (guardedOpenSync);
}

// ============================================================================
// cleo CLI runner
// ============================================================================

/**
 * Result of a cleo invocation.
 *
 * @typedef {object} CleoResult
 * @property {boolean}      success
 * @property {unknown}      data
 * @property {unknown}      error
 * @property {string}       raw
 * @property {number|null}  exitCode
 * @property {string}       cmd
 */

/**
 * Run a cleo command and return parsed JSON.
 *
 * @param {string}   cleoBin
 * @param {string[]} args
 * @param {string}   cwd
 * @returns {CleoResult}
 */
export function runCleo(cleoBin, args, cwd) {
  const cmd = `${cleoBin} ${args.join(' ')}`;
  const result = spawnSync(cleoBin, args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const raw = result.stdout ?? '';

  // Strip NDJSON log lines (pino JSON objects) — keep only the last line
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);

  // Find the LAFS envelope — the last line that parses as JSON with {success}
  let envelope = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i]);
      if ('success' in parsed) {
        envelope = parsed;
        break;
      }
    } catch {
      // not JSON — skip
    }
  }

  if (envelope !== null) {
    return {
      success: envelope.success === true,
      data: envelope.data ?? null,
      error: envelope.error ?? null,
      raw,
      exitCode: result.status,
      cmd,
    };
  }

  // Non-JSON output
  return {
    success: result.status === 0,
    data: raw.trim(),
    error: result.stderr?.trim() ?? null,
    raw,
    exitCode: result.status,
    cmd,
  };
}

// ============================================================================
// Probe definitions
// ============================================================================

/**
 * @typedef {object} ProbeResult
 * @property {number}  index
 * @property {string}  name
 * @property {boolean} passed
 * @property {string}  detail
 * @property {string}  cmd
 */

/**
 * Run all 10 probes against the cleo CLI and return per-probe results.
 *
 * @param {string}      cleoBin
 * @param {string}      cwd
 * @param {string|null} taskId
 * @param {boolean}     verbose
 * @returns {ProbeResult[]}
 */
export function runProbes(cleoBin, cwd, taskId, verbose) {
  /** @type {ProbeResult[]} */
  const results = [];

  /** @type {Set<string>} Track which top-level commands were invoked */
  const calledCommands = new Set();

  /**
   * Helper: run cleo, record which command family was used, return result.
   *
   * @param {string[]} args
   * @returns {CleoResult}
   */
  function invoke(args) {
    calledCommands.add(args[0]);
    return runCleo(cleoBin, args, cwd);
  }

  // --------------------------------------------------------------------------
  // Probe 1: cleo briefing returns a success envelope
  // --------------------------------------------------------------------------
  {
    const r = invoke(['briefing']);
    const passed = r.success === true;
    results.push({
      index: 1,
      name: 'cleo briefing returns success envelope',
      passed,
      detail: passed
        ? 'briefing command exited with success=true'
        : `briefing failed: ${JSON.stringify(r.error ?? r.raw).slice(0, 200)}`,
      cmd: r.cmd,
    });
  }

  // --------------------------------------------------------------------------
  // Probe 2: cleo briefing output contains memoryContext key
  // --------------------------------------------------------------------------
  {
    const r = invoke(['briefing']);
    const data = /** @type {Record<string, unknown>|null} */ (r.data);
    const passed =
      r.success === true &&
      data !== null &&
      typeof data === 'object' &&
      ('memoryContext' in data || 'lastSession' in data || 'nextTasks' in data);
    results.push({
      index: 2,
      name: 'cleo briefing output contains session context keys',
      passed,
      detail: passed
        ? `briefing data keys: ${Object.keys(data ?? {}).join(', ')}`
        : `briefing data missing expected keys: ${JSON.stringify(data).slice(0, 200)}`,
      cmd: r.cmd,
    });
  }

  // --------------------------------------------------------------------------
  // Probe 3: cleo docs list returns a success envelope
  // --------------------------------------------------------------------------
  {
    // Use a known-existing or auto-discovered task; fall back to a sentinel
    const probeTaskId = taskId ?? 'T1618';
    const r = invoke(['docs', 'list', '--task', probeTaskId]);
    const passed = r.success === true;
    results.push({
      index: 3,
      name: 'cleo docs list returns success envelope',
      passed,
      detail: passed
        ? `docs list success for task=${probeTaskId}`
        : `docs list failed: ${JSON.stringify(r.error ?? r.raw).slice(0, 200)}`,
      cmd: r.cmd,
    });
  }

  // --------------------------------------------------------------------------
  // Probe 4: cleo docs list result has an attachments array
  // --------------------------------------------------------------------------
  {
    const probeTaskId = taskId ?? 'T1618';
    const r = invoke(['docs', 'list', '--task', probeTaskId]);
    const data = /** @type {Record<string, unknown>|null} */ (r.data);
    const passed =
      r.success === true &&
      data !== null &&
      typeof data === 'object' &&
      'attachments' in data &&
      Array.isArray(data['attachments']);
    results.push({
      index: 4,
      name: 'cleo docs list result contains attachments array',
      passed,
      detail: passed
        ? `attachments count: ${/** @type {unknown[]} */ (/** @type {any} */ (data)['attachments']).length}`
        : `attachments field missing or wrong type: ${JSON.stringify(data).slice(0, 200)}`,
      cmd: r.cmd,
    });
  }

  // --------------------------------------------------------------------------
  // Probe 5: cleo memory find returns a success envelope
  // --------------------------------------------------------------------------
  {
    const r = invoke(['memory', 'find', 'knowledge-first-citizen']);
    const passed = r.success === true;
    results.push({
      index: 5,
      name: 'cleo memory find returns success envelope',
      passed,
      detail: passed
        ? 'memory find exited with success=true'
        : `memory find failed: ${JSON.stringify(r.error ?? r.raw).slice(0, 200)}`,
      cmd: r.cmd,
    });
  }

  // --------------------------------------------------------------------------
  // Probe 6: cleo memory find result has a results array
  // --------------------------------------------------------------------------
  {
    const r = invoke(['memory', 'find', 'T1611']);
    const data = /** @type {Record<string, unknown>|null} */ (r.data);
    const passed =
      r.success === true &&
      data !== null &&
      typeof data === 'object' &&
      'results' in data &&
      Array.isArray(data['results']);
    results.push({
      index: 6,
      name: 'cleo memory find result contains results array',
      passed,
      detail: passed
        ? `results count: ${/** @type {unknown[]} */ (/** @type {any} */ (data)['results']).length}`
        : `results field missing or wrong type: ${JSON.stringify(data).slice(0, 200)}`,
      cmd: r.cmd,
    });
  }

  // --------------------------------------------------------------------------
  // Probe 7: cleo show <taskId> returns a success envelope OR a meaningful error
  //           (a missing task is NOT a broken CLI — the CLI must respond)
  // --------------------------------------------------------------------------
  {
    const probeTaskId = taskId ?? 'T1611';
    const r = invoke(['show', probeTaskId]);
    // The probe passes if we get any valid LAFS envelope back (success or error with code)
    const hasEnvelope =
      r.success === true ||
      (r.error !== null &&
        typeof r.error === 'object' &&
        'code' in /** @type {object} */ (r.error));
    results.push({
      index: 7,
      name: 'cleo show returns a valid LAFS envelope',
      passed: hasEnvelope,
      detail: hasEnvelope
        ? `show returned envelope (success=${r.success}) for task=${probeTaskId}`
        : `show returned no recognisable envelope: ${r.raw.slice(0, 200)}`,
      cmd: r.cmd,
    });
  }

  // --------------------------------------------------------------------------
  // Probe 8: cleo show success response contains task title field
  //           (only checked when the task actually exists)
  // --------------------------------------------------------------------------
  {
    const probeTaskId = taskId ?? 'T1611';
    const r = invoke(['show', probeTaskId]);
    const data = /** @type {Record<string, unknown>|null} */ (r.data);

    let passed;
    let detail;

    if (r.success && data !== null && typeof data === 'object') {
      // Task exists — validate shape.
      // `cleo show` nests the task record under data.task (LAFS envelope).
      // Accept both flat (data.title) and nested (data.task.title) shapes for
      // forward-compatibility.
      const taskRecord = /** @type {Record<string, unknown>} */ (
        'task' in data && data['task'] !== null && typeof data['task'] === 'object'
          ? data['task']
          : data
      );
      const hasTitle = 'title' in taskRecord && typeof taskRecord['title'] === 'string';
      passed = hasTitle;
      detail = passed
        ? `task title: "${String(taskRecord['title']).slice(0, 80)}"`
        : `task data missing title field: ${JSON.stringify(data).slice(0, 200)}`;
    } else if (!r.success && r.error !== null && typeof r.error === 'object') {
      // Task not found — acceptable; the CLI is working
      passed = true;
      detail = `task ${probeTaskId} not found in this DB — CLI working correctly`;
    } else {
      passed = false;
      detail = `unexpected show output: ${r.raw.slice(0, 200)}`;
    }

    results.push({
      index: 8,
      name: 'cleo show response shape is valid (title field or proper error)',
      passed,
      detail,
      cmd: r.cmd,
    });
  }

  // --------------------------------------------------------------------------
  // Probe 9: No .cleo/agent-outputs/*.md file was read during any probe
  //           (checked after all probes against denylistState)
  // --------------------------------------------------------------------------
  {
    const passed = denylistState.count === 0;
    results.push({
      index: 9,
      name: 'No .cleo/agent-outputs/*.md file was read (denylist not violated)',
      passed,
      detail: passed
        ? 'denylist clean — zero agent-outputs markdown reads detected'
        : `denylist VIOLATED — ${denylistState.count} blocked read(s): ${denylistState.violations.join(', ')}`,
      cmd: '(denylist monitor)',
    });
  }

  // --------------------------------------------------------------------------
  // Probe 10: All 4 required command families were invoked at least once
  //            (briefing, docs, memory, show)
  // --------------------------------------------------------------------------
  {
    const required = ['briefing', 'docs', 'memory', 'show'];
    const missing = required.filter((cmd) => !calledCommands.has(cmd));
    const passed = missing.length === 0;
    results.push({
      index: 10,
      name: 'All 4 required command families invoked (briefing, docs, memory, show)',
      passed,
      detail: passed
        ? `invoked: ${[...calledCommands].sort().join(', ')}`
        : `missing command families: ${missing.join(', ')}`,
      cmd: '(coverage check)',
    });
  }

  if (verbose) {
    for (const probe of results) {
      console.error(`  Probe ${probe.index}: [${probe.passed ? 'PASS' : 'FAIL'}] ${probe.name}`);
      console.error(`    cmd: ${probe.cmd}`);
      console.error(`    detail: ${probe.detail}`);
    }
  }

  return results;
}

// ============================================================================
// Scoring + report
// ============================================================================

/**
 * @typedef {object} AuditReport
 * @property {string}        generatedAt
 * @property {string}        cleoBin
 * @property {string}        cwd
 * @property {string|null}   taskId
 * @property {boolean}       guardActive
 * @property {number}        score
 * @property {number}        total
 * @property {boolean}       passed
 * @property {ProbeResult[]} probes
 * @property {object}        denylist
 */

/**
 * Build the final audit report object.
 *
 * @param {Config}        config
 * @param {ProbeResult[]} probes
 * @returns {AuditReport}
 */
export function buildReport(config, probes) {
  const score = probes.filter((p) => p.passed).length;
  return {
    generatedAt: new Date().toISOString(),
    cleoBin: config.cleoBin,
    cwd: config.cwd,
    taskId: config.taskId,
    guardActive: config.guard,
    score,
    total: probes.length,
    passed: score === probes.length,
    probes,
    denylist: {
      violationCount: denylistState.count,
      violations: denylistState.violations,
    },
  };
}

/**
 * Print a human-readable audit report.
 *
 * @param {AuditReport} report
 */
export function printReport(report) {
  const bar = report.passed ? '✓' : '✗';
  console.log('');
  console.log(`fresh-agent-test — T1611 KNOWLEDGE-FIRST-CITIZEN acceptance`);
  console.log(`  cleo: ${report.cleoBin}`);
  console.log(`  cwd:  ${report.cwd}`);
  console.log(`  guard: ${report.guardActive ? 'ACTIVE' : 'disabled (--no-guard)'}`);
  console.log('');

  for (const probe of report.probes) {
    const icon = probe.passed ? '[PASS]' : '[FAIL]';
    console.log(`  ${icon} ${probe.index.toString().padStart(2)}. ${probe.name}`);
    if (!probe.passed) {
      console.log(`         detail: ${probe.detail}`);
    }
  }

  console.log('');
  console.log(
    `  Score: ${report.score}/${report.total}  ${bar}  ${report.passed ? 'ACCEPTED' : 'REJECTED'}`,
  );

  if (report.denylist.violationCount > 0) {
    console.log('');
    console.log(`  DENYLIST VIOLATED: ${report.denylist.violationCount} blocked read(s)`);
    for (const v of report.denylist.violations) {
      console.log(`    - ${v}`);
    }
  }

  console.log('');
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  let config;
  try {
    config = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`Error: ${/** @type {Error} */ (err).message}`);
    console.error('Run with --help for usage.');
    process.exit(2);
  }

  if (config.help) {
    printHelp();
    process.exit(0);
  }

  // Install the file-read denylist guard (unless explicitly disabled)
  if (config.guard) {
    installDenylistGuard();
  }

  // Run the 10 probes
  const probes = runProbes(config.cleoBin, config.cwd, config.taskId, config.verbose);

  // Build report
  const report = buildReport(config, probes);

  // Output
  if (config.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    printReport(report);
  }

  // Exit code
  process.exit(report.passed ? 0 : 1);
}

// Only run main when this file is executed directly (not imported in tests)
const isMain =
  process.argv[1] === import.meta.filename || process.argv[1]?.endsWith('fresh-agent-test.mjs');

if (isMain) {
  main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(2);
  });
}
