/**
 * Worktree-isolation guard for CLEO DB opens (T9806 / T9961 / council verdict D009).
 *
 * Extracted into a standalone leaf module so it can be imported by both
 * `open-cleo-db.ts` (which owns the `CleoDbRole` union and the main chokepoint)
 * AND `sqlite.ts` (where `getDb()` lives) — without creating a circular import
 * cycle.
 *
 * Before this extraction, `assertDbPathIsNotWorktreeResident` lived in
 * `open-cleo-db.ts`, which imports `getDb` from `sqlite.ts`. If `sqlite.ts`
 * had tried to import the guard from `open-cleo-db.ts`, the import cycle would
 * have caused a TDZ failure at module-init time.
 *
 * @task T9961 (extraction), T9806 (original guard)
 * @saga T9800
 * @decision D009
 */

import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ExitCode } from '@cleocode/contracts';
import { CleoError } from '../errors.js';
import { getCleoDirAbsolute } from '../paths.js';

/**
 * Worktree-isolation guard for the DB chokepoint (T9806 / council verdict D009).
 *
 * Defense-in-depth on top of T9803's `getCleoDirAbsolute` THROWS-on-orphan
 * fix. After path resolution, this verifies the resolved `.cleo/`'s parent
 * directory is the **canonical project root** (i.e. `.git` is a real
 * directory) rather than a **git worktree** (i.e. `.git` is a gitlink file).
 *
 * Refusing worktree-resident opens prevents the residual orphan path where a
 * leaked `.cleo/` already exists inside a worktree from a pre-T9803 install:
 * T9803 stops NEW creation, T9806 stops re-use of an OLD leak.
 *
 * Kill-switch: `CLEO_ALLOW_WORKTREE_DB_CREATE=1` bypasses the guard. The
 * override is recorded to stderr (caller may pipe to audit log).
 *
 * @param role - The DB role label (used in the error message only).
 * @param cwd  - Optional working directory; defaults to `process.cwd()`.
 *
 * @throws `CleoError('E_WT_DB_ISOLATION_VIOLATION')` when:
 *   - The resolved `.cleo/`'s parent directory contains `.git` as a FILE
 *     (gitlink — worktree marker), AND
 *   - `CLEO_ALLOW_WORKTREE_DB_CREATE` is not set to `'1'`.
 */
export function assertDbPathIsNotWorktreeResident(role: string, cwd?: string): void {
  let cleoDir: string;
  try {
    cleoDir = getCleoDirAbsolute(cwd);
  } catch {
    // T9803 already throws on unresolvable project root. Re-raising here
    // would lose context; let the underlying opener surface the original
    // error.
    return;
  }
  const projectRoot = dirname(cleoDir);
  const projectGit = join(projectRoot, '.git');
  let isWorktreeGitlink = false;
  try {
    isWorktreeGitlink = existsSync(projectGit) && statSync(projectGit).isFile();
  } catch {
    /* If `.git` itself is missing, this isn't our concern — T9803 will fire. */
  }
  if (!isWorktreeGitlink) {
    return;
  }
  if (process.env['CLEO_ALLOW_WORKTREE_DB_CREATE'] === '1') {
    process.stderr.write(
      `[T9806 WT-DB-OVERRIDE] role=${role} path=${cleoDir} reason=CLEO_ALLOW_WORKTREE_DB_CREATE=1\n`,
    );
    return;
  }
  throw new CleoError(
    ExitCode.CONFIG_ERROR,
    `E_WT_DB_ISOLATION_VIOLATION: refusing to open '${role}' DB at ${cleoDir} — parent ${projectRoot} is a git worktree (gitlink). DBs must open against the canonical project root.`,
    {
      fix: `Run from the canonical project root, OR delete the leaked .cleo/ inside the worktree, OR set CLEO_ALLOW_WORKTREE_DB_CREATE=1 (emergency override, audited).`,
    },
  );
}
