#!/usr/bin/env node

/**
 * Stamp `packages/core/dist/build-provenance.json` with where this build came
 * from (T12687).
 *
 * A build made inside a linked git worktree carries that branch's UNRELEASED
 * migrations and schema code. The runtime guard (`store/worktree-build-guard`)
 * refuses to let such a build change the schema of any store outside its own
 * worktree. Path detection alone is not enough: `npm pack` from a worktree
 * installed globally lives under `node_modules`, and a `dist` copied outside
 * any checkout has no worktree around it. The stamp travels with the build.
 *
 * `linkedWorktree` is the worktree's top-level directory when the git dir and
 * the common git dir differ (a linked worktree), else null — a main checkout or
 * a CI clone, which is how released packages are built.
 *
 * @module write-build-provenance
 * @task T12687
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function git(...args) {
  try {
    return execFileSync('git', args, { cwd: packageRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

const gitDir = git('rev-parse', '--path-format=absolute', '--git-dir');
const commonDir = git('rev-parse', '--path-format=absolute', '--git-common-dir');
const linkedWorktree =
  gitDir && commonDir && resolve(gitDir) !== resolve(commonDir) ? git('rev-parse', '--show-toplevel') : null;

const stamp = {
  schema: 1,
  linkedWorktree,
  gitHead: git('rev-parse', 'HEAD'),
  builtAt: new Date().toISOString(),
};

const out = resolve(packageRoot, 'dist', 'build-provenance.json');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(stamp, null, 2)}\n`);
