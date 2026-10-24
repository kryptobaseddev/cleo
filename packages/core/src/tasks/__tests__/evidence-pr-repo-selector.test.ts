/**
 * `pr:<owner>/<repo>#<n>` and `ci:<owner>/<repo>#<n>` selectors against the
 * evidence git root's origin (T14018, follow-up of T13912): a matching
 * selector keeps `repo` on the persisted atom, and `ci:` is refused against
 * another origin and accepted against its own.
 *
 * @task T14018
 */

import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EvidenceValidationContext } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type PrAtomResolution, resolvePrEvidenceAtom } from '../../release/pr-evidence.js';
import { validateAtom } from '../evidence.js';

vi.mock('../../release/pr-evidence.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../release/pr-evidence.js')>()),
  resolvePrEvidenceAtom: vi.fn(),
}));
/** The `ci:` resolver the selector delegates to, counted. */
const ci = vi.hoisted(() => ({ calls: 0 }));
vi.mock('../../release/ci-evidence.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../release/ci-evidence.js')>()),
  resolveCiEvidenceAtom: async (prNumber: number) => {
    ci.calls++;
    return {
      ok: true as const,
      atom: {
        kind: 'ci' as const,
        prNumber,
        mergeCommitSha: 'a'.repeat(40),
        checks: [{ name: 'CI', conclusion: 'success', sha: 'a'.repeat(40) }],
      },
    };
  },
}));

let root: string;
let checkout: string;
const context: EvidenceValidationContext = {
  task: { id: 'T14018', kind: 'bug', files: ['src/fix.ts'] },
  gates: ['implemented'],
  criteria: [],
};
const pr: Extract<PrAtomResolution, { ok: true }> = {
  ok: true,
  prNumber: 87,
  mergeCommitSha: 'a'.repeat(40),
  mergedAt: '2026-10-24T00:00:00Z',
  successCount: 3,
  totalChecks: 3,
  cacheHit: false,
  title: 'fix(T14018): implementation',
  body: 'Task T14018',
  headRefName: 'task/T14018',
  changedPaths: ['src/fix.ts'],
  changedFileCount: 1,
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cleo-t14018-store-'));
  checkout = await mkdtemp(join(tmpdir(), 'cleo-t14018-repo-'));
  execFileSync('git', ['init', '-q', checkout]);
  execFileSync('git', ['-C', checkout, 'remote', 'add', 'origin', 'git@github.com:Acme/App.git']);
  process.env.CLEO_EVIDENCE_GIT_ROOT = checkout;
  vi.mocked(resolvePrEvidenceAtom).mockResolvedValue(pr);
  ci.calls = 0;
});
afterEach(async () => {
  delete process.env.CLEO_EVIDENCE_GIT_ROOT;
  vi.clearAllMocks();
  await rm(root, { recursive: true, force: true });
  await rm(checkout, { recursive: true, force: true });
});

describe('repository selectors on pr:/ci: (T14018)', () => {
  it('a matching pr: selector keeps repo on the persisted atom (ssh origin)', async () => {
    const r = await validateAtom(
      { kind: 'pr', prNumber: 87, repo: 'acme/app' },
      root,
      'T14018',
      undefined,
      context,
    );
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.ok && r.atom).toMatchObject({ kind: 'pr', prNumber: 87, repo: 'acme/app' });
  });

  it('ci: is refused against another origin and accepted, with repo, against its own', async () => {
    const other = await validateAtom({ kind: 'ci', prNumber: 87, repo: 'acme/app-cloud' }, root);
    expect(!other.ok && other.reason).toMatch(/names acme\/app-cloud, .* has origin acme\/app\./);
    expect(ci.calls).toBe(0);
    const own = await validateAtom({ kind: 'ci', prNumber: 87, repo: 'acme/app' }, root);
    expect(own.ok, JSON.stringify(own)).toBe(true);
    expect(own.ok && own.atom).toMatchObject({ kind: 'ci', prNumber: 87, repo: 'acme/app' });
  });
});
