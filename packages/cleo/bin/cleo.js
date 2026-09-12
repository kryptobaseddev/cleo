#!/usr/bin/env -S node --max-old-space-size=1536 --disable-warning=ExperimentalWarning
/**
 * T1138 / T11829 / T12115: entry point for the CLEO CLI.
 *
 * ## Why the flags live in the shebang (T12115)
 *
 * Two Node flags must be set before any JS runs: `--disable-warning` (the
 * node:sqlite ExperimentalWarning fires during ESM resolution) and
 * `--max-old-space-size` (a runaway invocation should throw a recoverable
 * single-process heap OOM rather than grow into a host-wide stall).
 *
 * The original wrapper got them by re-executing Node through
 * `execFileSync('node', [...flags, cliPath, ...args])`. That was correct and
 * cost more than it looked:
 *
 *   - **Every `cleo` call was two Node processes.** Measured 2026-09-12 on a
 *     live box: a ~40 MB shim blocked on a ~60 MB child, per invocation, across
 *     nine concurrent agent sessions.
 *   - **Node boot was paid twice per command** — a meaningful share of the
 *     ~6 s/call latency reported in issue #1207.
 *   - **Signals could not be forwarded.** `execFileSync` blocks the shim's own
 *     event loop, so a SIGTERM delivered to the shim never reached the child.
 *     The child orphaned and kept running — the mechanism behind the orphaned
 *     evidence-tool slot holders in issue #1222 and the bare `exit 143` with no
 *     output in issue #1237.
 *
 * `env -S` passes the flags on Node's own command line, so the common path is
 * now ONE process that signals reach directly. The re-exec survives only for
 * the rare `CLEO_MAX_OLD_SPACE_MB` override (a large export/import needing more
 * headroom) and as a fallback where the shebang's flags did not take effect —
 * notably Windows, whose npm-generated shims do not honour a shebang the way a
 * POSIX kernel does. That fallback now uses `spawn` with real signal
 * forwarding, so even it cannot orphan a child.
 */

import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliPath = resolve(__dirname, '../dist/cli/index.js');
const args = process.argv.slice(2);

/** Default V8 old-space cap, in MB. Overridable via `CLEO_MAX_OLD_SPACE_MB`. */
const DEFAULT_HEAP_CAP_MB = 1536;

const requested = Number.parseInt(process.env.CLEO_MAX_OLD_SPACE_MB ?? '', 10);
const heapCapMb = Number.isFinite(requested) && requested > 0 ? requested : DEFAULT_HEAP_CAP_MB;

/**
 * Whether this process already runs under the intended heap cap.
 *
 * Checks for the flag itself rather than inferring it from
 * `v8.getHeapStatistics().heap_size_limit`. V8 reports a limit ABOVE the
 * requested value by a ratio that is not constant — measured on Node 24:
 * `--max-old-space-size=1536` reports 1728 MB (×1.125) while `=777` reports
 * 969 MB (×1.247). Any tolerance wide enough for the second is nearly wide
 * enough to accept an uncapped process, so a threshold here would be a coin
 * flip. The flag is exact and covers every route it can arrive by: the shebang
 * and an outer re-exec both land in `execArgv`, and an operator's own setting
 * lands in `NODE_OPTIONS`.
 */
function heapCapAlreadyApplied() {
  const flag = `--max-old-space-size=${heapCapMb}`;
  if (process.execArgv.includes(flag)) return true;
  return (process.env.NODE_OPTIONS ?? '').split(/\s+/).includes(flag);
}

if (heapCapAlreadyApplied()) {
  // Common path: single process. Signals reach the CLI directly.
  await import(cliPath);
} else {
  // Fallback path: re-exec once with the flags, forwarding signals so the child
  // can never outlive us the way the old execFileSync child could.
  const child = spawn(
    process.execPath,
    [`--max-old-space-size=${heapCapMb}`, '--disable-warning=ExperimentalWarning', cliPath, ...args],
    { stdio: 'inherit', cwd: process.cwd() },
  );

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => {
      if (!child.killed) child.kill(signal);
    });
  }

  child.on('exit', (code, signal) => {
    // Reproduce the child's termination for our own caller: a signalled child
    // must not be reported as a clean exit 0.
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  });

  child.on('error', (err) => {
    process.stderr.write(`cleo: failed to start CLI: ${err.message}\n`);
    process.exit(1);
  });
}
