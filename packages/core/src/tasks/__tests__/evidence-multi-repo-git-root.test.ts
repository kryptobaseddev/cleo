/**
 * A CLEO root that parents SEVERAL checkouts must still resolve (gh#1466).
 *
 * ## The defect
 *
 * gh#1462 taught the resolver to walk down to the one git work tree below the
 * CLEO root. The reported layout has thirteen:
 *
 * ```
 * /mnt/projects/axiom-analytics/          <- CLEO root, not a checkout
 *   axiom-app/  sdk/  legal/  media-lifecycle/ …   <- 13 sibling repositories
 * ```
 *
 * so the "exactly one" rule never fired, `commit:` and `pr:` both failed with
 * `E_EVIDENCE_GIT_ROOT`, and the remediation the error printed —
 * `GIT_DIR=<repo>/.git GIT_WORK_TREE=<repo> cleo verify …` — could not work
 * either. That is not a subtlety: with those variables set, from a parent of
 * the checkout, `git rev-parse --is-inside-work-tree` prints **`false`** and
 * exits 0, because the CURRENT DIRECTORY is outside the declared tree. The
 * guard asked the one question the workaround could never satisfy, so an
 * operator who followed the advice got the identical error and had nothing
 * left to try.
 *
 * ## What these tests pin
 *
 * 1. A `commit:` atom resolves the sibling that CONTAINS its SHA — the
 *    zero-configuration path, since a SHA names exactly one repository.
 * 2. `CLEO_EVIDENCE_GIT_ROOT`, `GIT_WORK_TREE` and `evidence.gitRoot` in
 *    `.cleo/project-context.json` each pin the checkout, with that precedence.
 *    The `GIT_WORK_TREE` case is the regression test for the advice above.
 * 3. A declared root that is NOT a checkout fails BY NAME rather than falling
 *    back to a different tree and attesting against it.
 * 4. The unresolvable case names the candidate checkouts, so the reader can
 *    act without reading the source.
 *
 * @task gh#1466
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

function git(dir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf-8' });
}

/** Init a repo with one real commit and return its SHA. */
function initRepoWithCommit(dir: string, marker: string): string {
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  writeFileSync(join(dir, 'marker.txt'), marker, 'utf-8');
  git(dir, ['add', 'marker.txt']);
  git(dir, ['commit', '-q', '-m', `init ${marker}`]);
  return git(dir, ['rev-parse', 'HEAD']).trim();
}

let storeRoot: string;
let appA: string;
let appB: string;
let shaA: string;
let shaB: string;
const saved: Record<string, string | undefined> = {};

const TRACKED_ENV = [
  'CLEO_EVIDENCE_GIT_ROOT',
  'GIT_WORK_TREE',
  'GIT_DIR',
  'CLEO_DIR',
  'CLEO_ROOT',
] as const;

beforeEach(() => {
  for (const key of TRACKED_ENV) saved[key] = process.env[key];
  for (const key of TRACKED_ENV) delete process.env[key];
  storeRoot = mkdtempSync(join(tmpdir(), 'multi-repo-root-'));
  mkdirSync(join(storeRoot, '.cleo'), { recursive: true });
  process.env.CLEO_ROOT = storeRoot;
  process.env.CLEO_DIR = join(storeRoot, '.cleo');
  appA = join(storeRoot, 'app-a');
  appB = join(storeRoot, 'app-b');
  shaA = initRepoWithCommit(appA, 'a');
  shaB = initRepoWithCommit(appB, 'b');
});

afterEach(() => {
  for (const key of TRACKED_ENV) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(storeRoot, { recursive: true, force: true });
});

/** The realpath the resolver reports, so `/tmp` symlinks cannot fail a match. */
function real(dir: string): string {
  return git(dir, ['rev-parse', '--show-toplevel']).trim();
}

describe('multi-repo CLEO root resolves by the commit under test (gh#1466)', () => {
  it('picks the sibling checkout that contains the SHA, with no configuration', async () => {
    const { resolveEvidenceExecutionRoot } = await import('../evidence.js');
    expect(resolveEvidenceExecutionRoot(storeRoot, storeRoot, { commitSha: shaA })).toBe(
      real(appA),
    );
    expect(resolveEvidenceExecutionRoot(storeRoot, storeRoot, { commitSha: shaB })).toBe(
      real(appB),
    );
  });

  it('validates a real commit: atom end to end from the CLEO root', async () => {
    const { validateAtom } = await import('../evidence.js');
    const result = await validateAtom({ kind: 'commit', sha: shaA }, storeRoot);
    expect(result.ok).toBe(true);
  });

  it('stays unresolved — and does not guess — when nothing identifies a repo', async () => {
    const { resolveEvidenceExecutionRoot } = await import('../evidence.js');
    expect(resolveEvidenceExecutionRoot(storeRoot, storeRoot)).toBe(storeRoot);
  });

  it('stays unresolved when a SHA is present in BOTH siblings', async () => {
    // Shared history is the one case where "the repo containing this object"
    // has more than one answer. Guessing here would attest a commit against a
    // repository the evidence was never about.
    git(appB, ['remote', 'add', 'a', appA]);
    git(appB, ['fetch', '-q', 'a']);
    const { resolveEvidenceExecutionRoot } = await import('../evidence.js');
    expect(resolveEvidenceExecutionRoot(storeRoot, storeRoot, { commitSha: shaA })).toBe(storeRoot);
  });
});

describe('declared evidence git roots are honoured (gh#1466)', () => {
  it('honours CLEO_EVIDENCE_GIT_ROOT, relative to the store root', async () => {
    process.env.CLEO_EVIDENCE_GIT_ROOT = 'app-b';
    const { resolveEvidenceExecutionRoot } = await import('../evidence.js');
    expect(resolveEvidenceExecutionRoot(storeRoot, storeRoot)).toBe(real(appB));
  });

  it('honours GIT_WORK_TREE — the workaround the old error text advertised', async () => {
    // Regression test for the advice itself. Before gh#1466 this produced the
    // same E_EVIDENCE_GIT_ROOT it was printed to resolve, because the guard
    // probed the CLEO root, which is outside the declared tree by definition.
    process.env.GIT_DIR = join(appA, '.git');
    process.env.GIT_WORK_TREE = appA;
    const { resolveEvidenceExecutionRoot } = await import('../evidence.js');
    expect(resolveEvidenceExecutionRoot(storeRoot, storeRoot)).toBe(real(appA));
  });

  it('honours evidence.gitRoot from project-context.json', async () => {
    writeFileSync(
      join(storeRoot, '.cleo', 'project-context.json'),
      JSON.stringify({
        schemaVersion: '1.0.0',
        detectedAt: '2026-09-21T00:00:00.000Z',
        projectTypes: ['node'],
        monorepo: false,
        evidence: { gitRoot: 'app-b' },
      }),
      'utf-8',
    );
    const { resolveEvidenceExecutionRoot } = await import('../evidence.js');
    expect(resolveEvidenceExecutionRoot(storeRoot, storeRoot)).toBe(real(appB));
  });

  it('prefers the environment override over the committed declaration', async () => {
    writeFileSync(
      join(storeRoot, '.cleo', 'project-context.json'),
      JSON.stringify({ schemaVersion: '1.0.0', evidence: { gitRoot: 'app-b' } }),
      'utf-8',
    );
    process.env.CLEO_EVIDENCE_GIT_ROOT = appA;
    const { resolveEvidenceExecutionRoot } = await import('../evidence.js');
    expect(resolveEvidenceExecutionRoot(storeRoot, storeRoot)).toBe(real(appA));
  });

  it('fails by name when the declared root is not a checkout, instead of substituting one', async () => {
    const notARepo = join(storeRoot, 'docs');
    mkdirSync(notARepo, { recursive: true });
    process.env.CLEO_EVIDENCE_GIT_ROOT = notARepo;
    const { validateAtom } = await import('../evidence.js');
    const result = await validateAtom({ kind: 'commit', sha: shaA }, storeRoot);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.codeName).toBe('E_EVIDENCE_GIT_ROOT');
    expect(result.reason).toContain('CLEO_EVIDENCE_GIT_ROOT');
    // The whole point: the commit DOES exist in app-a, and CLEO still refused.
    expect(result.reason).not.toContain('app-a/');
  });
});

describe('the unresolvable failure names what the reader must choose between (gh#1466)', () => {
  it('lists the candidate checkouts and the durable way to pin one', async () => {
    const { validateAtom } = await import('../evidence.js');
    const result = await validateAtom({ kind: 'commit', sha: 'deadbee' }, storeRoot);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.codeName).toBe('E_EVIDENCE_GIT_ROOT');
    expect(result.reason).toContain('app-a');
    expect(result.reason).toContain('app-b');
    expect(result.reason).toContain('evidence');
    expect(result.reason).toContain('CLEO_EVIDENCE_GIT_ROOT');
  });

  it('no longer prescribes the GIT_DIR/GIT_WORK_TREE pair it could not satisfy', async () => {
    // The old text named both variables as the fix for exactly this failure.
    // `GIT_WORK_TREE` now works and may legitimately be mentioned; the PAIR,
    // presented as the remedy, must not come back.
    const { validateAtom } = await import('../evidence.js');
    const result = await validateAtom({ kind: 'commit', sha: 'deadbee' }, storeRoot);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).not.toContain('GIT_DIR=');
  });
});
