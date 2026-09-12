#!/usr/bin/env node
/**
 * T1138 / T11829 / T12115: entry point for the CLEO CLI.
 *
 * ## The shebang is `#!/usr/bin/env node` and MUST stay that way (T12115)
 *
 * Two Node flags would ideally be set before any JS runs: `--disable-warning`
 * (the node:sqlite ExperimentalWarning fires during ESM resolution) and
 * `--max-old-space-size` (a runaway invocation should throw a recoverable
 * single-process heap OOM rather than grow into a host-wide stall, T11829).
 *
 * `#!/usr/bin/env -S node --max-old-space-size=1536 …` looks like the clean way
 * to get both in one process, and it was tried here. **It breaks the CLI
 * completely on musl/BusyBox systems.** Measured 2026-09-12 against the
 * official `node:22-alpine` image, where `/usr/bin/env` is a symlink to
 * `/bin/busybox`:
 *
 *     $ ./dashS.js
 *     /usr/bin/env: unrecognized option: S
 *     Usage: env [-i0] [-u NAME]... [-] [NAME=VALUE]... [PROG ARGS]
 *     exit=1
 *
 * BusyBox 1.37.0 (2026-01-10) has no `-S`; only `-i`, `-0` and `-u`. The same
 * script with a plain `#!/usr/bin/env node` ran fine. This failure happens at
 * exec time, before a single byte of this file is parsed, so NO in-process
 * fallback can rescue it — `cleo` is simply unlaunchable. GNU coreutils (≥8.30)
 * and BSD/macOS both support `-S`, which is exactly what makes the trap
 * dangerous: it passes on the machines most maintainers test on.
 *
 * The `T929` gate in `src/cli/__tests__/bin-shebang.test.ts` pins the exact
 * first line and is what caught this. Do not relax it to accommodate flags.
 *
 * ## How the flags are applied instead
 *
 * If the heap cap is already in effect — an operator's `NODE_OPTIONS`, or our
 * own re-exec below — this process IS the CLI: one process, and signals reach
 * it directly. Otherwise we re-exec once with the flags.
 *
 * The re-exec is deliberately `spawn`, not the `execFileSync` this file used
 * before T12115. `execFileSync` blocks the shim's event loop, so a SIGTERM
 * delivered to the shim never reached the child; the child orphaned and kept
 * running. That is the mechanism behind the orphaned evidence-tool slot holders
 * in issue #1222 and the bare `exit 143` with no output in issue #1237. With
 * `spawn` plus the forwarders below, the child cannot outlive us.
 *
 * Re-exec costs one transient process and roughly 10 ms of extra Node boot
 * (measured 1.33 s vs 1.34 s end-to-end, i.e. inside run-to-run noise), which
 * is the right price for a fail-safe that works on every platform.
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
 * Whether this process already runs under SOME deliberate old-space cap.
 *
 * Deliberately matches ANY `--max-old-space-size`, not our own value. An
 * operator who exports `NODE_OPTIONS=--max-old-space-size=4096` for a large
 * export has made an explicit choice, and re-execing to impose our 1536 MB
 * default would silently *lower* it — breaking the very command they raised it
 * for. This is the same rule `mergeNodeOptions()` applies in
 * `core/src/tasks/heavy-tool-env.ts`: an existing explicit value outranks our
 * default.
 *
 * Checks for the flag rather than inferring it from
 * `v8.getHeapStatistics().heap_size_limit`. V8 reports a limit ABOVE the
 * requested value by a ratio that is not constant — measured on Node 24:
 * `--max-old-space-size=1536` reports 1728 MB (×1.125) while `=777` reports
 * 969 MB (×1.247). Any tolerance wide enough for the second is nearly wide
 * enough to accept an uncapped process, so a threshold here would be a coin
 * flip. The flag is exact and covers both routes it can arrive by: our own
 * re-exec lands it in `execArgv`, an operator's setting in `NODE_OPTIONS`.
 */
function heapCapApplied() {
  const carriesCap = (argv) => argv.some((a) => a.startsWith('--max-old-space-size='));
  if (carriesCap(process.execArgv)) return true;
  return carriesCap((process.env.NODE_OPTIONS ?? '').split(/\s+/));
}

if (heapCapApplied()) {
  // Single-process path: signals reach the CLI directly, no child to orphan.
  await import(cliPath);
} else {
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
