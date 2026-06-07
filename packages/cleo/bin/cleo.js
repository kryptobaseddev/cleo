#!/usr/bin/env node
/**
 * T1138: Wrapper script for the CLEO CLI.
 *
 * This wrapper invokes the actual CLI bundle with Node.js flags to suppress
 * the ExperimentalWarning for node:sqlite. The warning fires during ESM module
 * resolution (before any JS code executes), so it must be suppressed at the
 * Node runtime level, not in application code.
 *
 * T11829 (fleet OOM fail-safe): the wrapper also caps the V8 old-space heap
 * (`--max-old-space-size`) so a single runaway `cleo` invocation throws a
 * recoverable, single-process JavaScript heap OOM instead of growing unbounded
 * and contributing to a host-wide SIGKILL. The cap is overridable via
 * `CLEO_MAX_OLD_SPACE_MB` for the rare command (large export/import) that needs
 * more headroom. This is a process-level guard ABOVE the per-connection SQLite
 * memory bounding in dual-scope-db.ts — defense in depth.
 *
 * See: https://github.com/kryptobaseddev/cleo/issues/XXX (T1138)
 */

import { execFileSync } from 'child_process';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliPath = resolve(__dirname, '../dist/cli/index.js');
const args = process.argv.slice(2);

// T11829: cap V8 old-space so a runaway throws a recoverable single-process OOM
// rather than a host SIGKILL. Default 1536 MB; override via CLEO_MAX_OLD_SPACE_MB.
const maxOldSpaceMb = Number.parseInt(process.env.CLEO_MAX_OLD_SPACE_MB ?? '', 10);
const heapCapMb = Number.isFinite(maxOldSpaceMb) && maxOldSpaceMb > 0 ? maxOldSpaceMb : 1536;

try {
  execFileSync(
    'node',
    [
      `--max-old-space-size=${heapCapMb}`,
      '--disable-warning=ExperimentalWarning',
      cliPath,
      ...args,
    ],
    {
      stdio: 'inherit',
      cwd: process.cwd(),
    },
  );
} catch (error) {
  process.exit(error.status || 1);
}
