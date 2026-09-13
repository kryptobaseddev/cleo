/**
 * Tests for the `pr:<number>` evidence atom (T9764).
 *
 * Covers:
 *   - parser accepts `pr:<positive integer>`
 *   - parser rejects malformed numbers (negative, non-int, alpha)
 *   - resolver happy path: merged PR with all required checks green
 *   - resolver rejects open PRs (not merged)
 *   - resolver rejects PRs with required-workflow FAILURE
 *   - resolver rejects PRs whose required workflows did not run
 *   - resolver returns E_EVIDENCE_TOOL_FAILED when `gh` is missing
 *   - cache hit on re-call avoids invoking `gh`
 *   - cache invalidates when mergedAt changes
 *   - gate-evidence-minimum accepts `pr` for implemented, testsPassed, AND qaPassed (T9838)
 *   - validateAtom dispatches `pr` through to the resolver
 *   - branch-protection tier resolves required workflows from the TARGET repo (gh#1192 / T12104)
 *   - missing-workflows rejection prints both sides plus the list source (gh#1198 / T12104)
 *
 * Uses an injectable `FetchGhPrPayload` mock to keep tests hermetic — no
 * real network calls happen.
 *
 * @task T9764
 * @task T9838
 * @task T12104
 * @epic T9762
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type EvidenceAtom,
  PR_REQUIRED_WORKFLOWS,
  PR_REQUIRED_WORKFLOWS_CONTEXT_KEY,
  PR_REQUIRED_WORKFLOWS_ENV_VAR,
} from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkGateEvidenceMinimum, parseEvidence, validateAtom } from '../../tasks/evidence.js';
import {
  branchProtectionCachePath,
  evaluateRollup,
  type FetchGhBranchProtection,
  type FetchGhPrPayload,
  prCacheEntryPath,
  resolvePrEvidenceAtom,
  resolveRequiredWorkflows,
} from '../pr-evidence.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Build a `gh pr view` JSON payload with the conventional CI rollup. The
 * default has every required-workflow check at SUCCESS so callers can
 * mutate one field per test instead of constructing the full object each
 * time.
 */
function makePrPayload(overrides: Record<string, unknown> = {}): unknown {
  return {
    state: 'MERGED',
    mergedAt: '2026-05-20T17:14:35Z',
    mergeable: 'MERGEABLE',
    headRefOid: 'a'.repeat(40),
    statusCheckRollup: [
      {
        __typename: 'CheckRun',
        name: 'Build & Verify (ubuntu-latest)',
        workflowName: 'CI',
        conclusion: 'SUCCESS',
        status: 'COMPLETED',
      },
      {
        __typename: 'CheckRun',
        name: 'Type Check',
        workflowName: 'CI',
        conclusion: 'SUCCESS',
        status: 'COMPLETED',
      },
      {
        __typename: 'CheckRun',
        name: 'Verify pnpm-lock.yaml consistency',
        workflowName: 'Lockfile Check',
        conclusion: 'SUCCESS',
        status: 'COMPLETED',
      },
      {
        __typename: 'CheckRun',
        name: 'Contracts Dep Lint',
        workflowName: 'Contracts Dep Lint',
        conclusion: 'SUCCESS',
        status: 'COMPLETED',
      },
    ],
    ...overrides,
  };
}

let projectRoot: string;
let fetchSpy: ReturnType<typeof vi.fn>;
let mockFetch: FetchGhPrPayload;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'cleo-pr-atom-test-'));
  fetchSpy = vi.fn();
  mockFetch = ((prNumber, cwd) => fetchSpy(prNumber, cwd)) as unknown as FetchGhPrPayload;
  // gh#1323 — these fixtures used to inherit `PR_REQUIRED_WORKFLOWS` implicitly,
  // because an unresolvable required set fell through to cleocode's own gate
  // names. It no longer does: an undetermined set is now `tier: 'unknown'` and
  // refuses. Every fixture that means "this project requires CI etc." must now
  // SAY so, which is exactly what the change asks of real projects — and the
  // fact that 15 tests silently depended on that fallback is the measure of how
  // invisible it was.
  process.env[PR_REQUIRED_WORKFLOWS_ENV_VAR] = 'CI,Lockfile Check,Contracts Dep Lint';
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
  delete process.env[PR_REQUIRED_WORKFLOWS_ENV_VAR];
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

describe('parseEvidence — pr atom (T9764)', () => {
  it('parses a single pr atom', () => {
    const r = parseEvidence('pr:357');
    expect(r.atoms).toEqual([{ kind: 'pr', prNumber: 357 }]);
  });

  it('parses pr atom alongside other atoms', () => {
    const r = parseEvidence('commit:abc1234;pr:42');
    expect(r.atoms).toHaveLength(2);
    expect(r.atoms[1]).toEqual({ kind: 'pr', prNumber: 42 });
  });

  it('rejects non-integer pr number', () => {
    expect(() => parseEvidence('pr:abc')).toThrow(/positive integer/);
  });

  it('rejects negative pr number', () => {
    expect(() => parseEvidence('pr:-5')).toThrow(/positive integer/);
  });

  it('rejects zero pr number', () => {
    expect(() => parseEvidence('pr:0')).toThrow(/positive integer/);
  });

  it('rejects fractional pr number', () => {
    expect(() => parseEvidence('pr:3.14')).toThrow(/positive integer/);
  });
});

// ---------------------------------------------------------------------------
// Resolver — happy path
// ---------------------------------------------------------------------------

describe('resolvePrEvidenceAtom — happy path', () => {
  it('accepts a merged PR with all required checks SUCCESS', async () => {
    fetchSpy.mockResolvedValue({ ok: true, payload: makePrPayload() });
    const r = await resolvePrEvidenceAtom(357, projectRoot, {
      fetchGhPrPayload: mockFetch,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.prNumber).toBe(357);
    expect(r.mergedAt).toBe('2026-05-20T17:14:35Z');
    expect(r.mergeCommitSha).toBe('a'.repeat(40));
    expect(r.cacheHit).toBe(false);
    expect(r.successCount).toBeGreaterThan(0);
  });

  it('writes a cache entry on first success', async () => {
    fetchSpy.mockResolvedValue({ ok: true, payload: makePrPayload() });
    await resolvePrEvidenceAtom(357, projectRoot, { fetchGhPrPayload: mockFetch });

    const cachePath = prCacheEntryPath(projectRoot, 357);
    expect(existsSync(cachePath)).toBe(true);
    const entry = JSON.parse(readFileSync(cachePath, 'utf-8'));
    expect(entry).toMatchObject({
      schemaVersion: 1,
      prNumber: 357,
      mergedAt: '2026-05-20T17:14:35Z',
    });
  });

  it('accepts a merged PR with mixed SUCCESS+FAILURE inside the CI workflow (PR-357 reality)', async () => {
    // PR #357 shipped with macos-latest shard 1 = FAILURE inside the CI
    // workflow, but ubuntu-latest builds + Lockfile Check + Contracts Dep
    // Lint were all SUCCESS. Since no FAILURE matches a required NAME
    // exactly, the atom must accept — mirroring the admin-merge that
    // actually shipped this PR.
    const payload = makePrPayload({
      statusCheckRollup: [
        {
          __typename: 'CheckRun',
          name: 'Build & Verify (ubuntu-latest)',
          workflowName: 'CI',
          conclusion: 'SUCCESS',
          status: 'COMPLETED',
        },
        {
          __typename: 'CheckRun',
          name: 'Unit Tests (macos-latest, shard 1)',
          workflowName: 'CI',
          conclusion: 'FAILURE',
          status: 'COMPLETED',
        },
        {
          __typename: 'CheckRun',
          name: 'Verify pnpm-lock.yaml consistency',
          workflowName: 'Lockfile Check',
          conclusion: 'SUCCESS',
          status: 'COMPLETED',
        },
        {
          __typename: 'CheckRun',
          name: 'Contracts Dep Lint',
          workflowName: 'CI',
          conclusion: 'SUCCESS',
          status: 'COMPLETED',
        },
      ],
    });
    fetchSpy.mockResolvedValue({ ok: true, payload });
    const r = await resolvePrEvidenceAtom(357, projectRoot, {
      fetchGhPrPayload: mockFetch,
    });
    expect(r.ok).toBe(true);
  });

  it('rejects a merged PR when a required check NAME is itself FAILURE', async () => {
    // A FAILURE on an exact-name-match required check is fatal — the
    // named gate explicitly failed, not just a sibling job in the same
    // workflow.
    const payload = makePrPayload({
      statusCheckRollup: [
        {
          __typename: 'CheckRun',
          name: 'Build & Verify (ubuntu-latest)',
          workflowName: 'CI',
          conclusion: 'SUCCESS',
          status: 'COMPLETED',
        },
        {
          __typename: 'CheckRun',
          name: 'Verify pnpm-lock.yaml consistency',
          workflowName: 'Lockfile Check',
          conclusion: 'SUCCESS',
          status: 'COMPLETED',
        },
        {
          __typename: 'CheckRun',
          name: 'Contracts Dep Lint',
          workflowName: 'CI',
          conclusion: 'FAILURE',
          status: 'COMPLETED',
        },
      ],
    });
    fetchSpy.mockResolvedValue({ ok: true, payload });
    const r = await resolvePrEvidenceAtom(357, projectRoot, {
      fetchGhPrPayload: mockFetch,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.codeName).toBe('E_EVIDENCE_TESTS_FAILED');
  });

  it('ignores non-required workflow failures when required workflows are green', async () => {
    // PR 357 shipped with a macOS shard failure — non-required workflow that
    // branch protection does not gate on. Atom should still accept.
    const payload = makePrPayload({
      statusCheckRollup: [
        ...(makePrPayload() as { statusCheckRollup: unknown[] }).statusCheckRollup,
        {
          __typename: 'CheckRun',
          name: 'Unit Tests (macos-latest, shard 1)',
          workflowName: 'Some-Optional-Workflow',
          conclusion: 'FAILURE',
          status: 'COMPLETED',
        },
      ],
    });
    fetchSpy.mockResolvedValue({ ok: true, payload });
    const r = await resolvePrEvidenceAtom(357, projectRoot, {
      fetchGhPrPayload: mockFetch,
    });
    expect(r.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Resolver — failure paths
// ---------------------------------------------------------------------------

describe('resolvePrEvidenceAtom — failure paths', () => {
  it('rejects unmerged PR (state=OPEN)', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      payload: makePrPayload({ state: 'OPEN', mergedAt: null }),
    });
    const r = await resolvePrEvidenceAtom(357, projectRoot, {
      fetchGhPrPayload: mockFetch,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.codeName).toBe('E_EVIDENCE_INSUFFICIENT');
    expect(r.reason).toMatch(/state.*OPEN/);
  });

  it('rejects PR with state=MERGED but null mergedAt (API race)', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      payload: makePrPayload({ mergedAt: null }),
    });
    const r = await resolvePrEvidenceAtom(357, projectRoot, {
      fetchGhPrPayload: mockFetch,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.codeName).toBe('E_EVIDENCE_INSUFFICIENT');
  });

  it('rejects PR with a required-workflow FAILURE', async () => {
    const payload = makePrPayload({
      statusCheckRollup: [
        {
          __typename: 'CheckRun',
          name: 'Build & Verify (ubuntu-latest)',
          workflowName: 'CI',
          conclusion: 'FAILURE',
          status: 'COMPLETED',
        },
        {
          __typename: 'CheckRun',
          name: 'Verify pnpm-lock.yaml consistency',
          workflowName: 'Lockfile Check',
          conclusion: 'SUCCESS',
          status: 'COMPLETED',
        },
        {
          __typename: 'CheckRun',
          name: 'Contracts Dep Lint',
          workflowName: 'Contracts Dep Lint',
          conclusion: 'SUCCESS',
          status: 'COMPLETED',
        },
      ],
    });
    fetchSpy.mockResolvedValue({ ok: true, payload });
    const r = await resolvePrEvidenceAtom(357, projectRoot, {
      fetchGhPrPayload: mockFetch,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.codeName).toBe('E_EVIDENCE_TESTS_FAILED');
    expect(r.reason).toMatch(/Required PR checks failed/);
  });

  it('rejects PR with a required-workflow pending', async () => {
    const payload = makePrPayload({
      statusCheckRollup: [
        {
          __typename: 'CheckRun',
          name: 'Build & Verify (ubuntu-latest)',
          workflowName: 'CI',
          conclusion: null,
          status: 'IN_PROGRESS',
        },
        {
          __typename: 'CheckRun',
          name: 'Verify pnpm-lock.yaml consistency',
          workflowName: 'Lockfile Check',
          conclusion: 'SUCCESS',
          status: 'COMPLETED',
        },
        {
          __typename: 'CheckRun',
          name: 'Contracts Dep Lint',
          workflowName: 'Contracts Dep Lint',
          conclusion: 'SUCCESS',
          status: 'COMPLETED',
        },
      ],
    });
    fetchSpy.mockResolvedValue({ ok: true, payload });
    const r = await resolvePrEvidenceAtom(357, projectRoot, {
      fetchGhPrPayload: mockFetch,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/still pending/);
  });

  it('rejects PR whose required workflows did not run at all', async () => {
    const payload = makePrPayload({
      statusCheckRollup: [
        {
          __typename: 'CheckRun',
          name: 'Some Other Job',
          workflowName: 'Some Unrelated Workflow',
          conclusion: 'SUCCESS',
          status: 'COMPLETED',
        },
      ],
    });
    fetchSpy.mockResolvedValue({ ok: true, payload });
    const r = await resolvePrEvidenceAtom(357, projectRoot, {
      fetchGhPrPayload: mockFetch,
      fetchGhBranchProtection: async () => ({ ok: false, reason: 'no branch protection' }),
      bypassCache: true,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    // gh#1198: the rejection names both sides and the source instead of
    // asserting the PR is at fault.
    expect(r.reason).toMatch(/required gates were not found/);
    // gh#1198 asks that the SOURCE be disclosed, not that it be any particular
    // tier. gh#1323 removed the built-in-default tier, so assert the disclosure
    // rather than the tier that used to provide it.
    expect(r.reason).toMatch(/required workflows \(source: .+\)/);
    expect(r.reason).toContain('- CI  NOT FOUND on this PR');
    expect(r.reason).toContain('- Some Other Job  SUCCESS');
    // T12100: the error must point at the override tiers, or consumers conclude
    // the cleocode gate list is hardcoded and invent workarounds.
    expect(r.reason).toContain('CLEO_PR_REQUIRED_WORKFLOWS');
    expect(r.reason).toContain('release.prRequiredWorkflows');
  });

  it('rejects invalid pr number (negative)', async () => {
    const r = await resolvePrEvidenceAtom(-1, projectRoot, {
      fetchGhPrPayload: mockFetch,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.codeName).toBe('E_EVIDENCE_INVALID');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns E_EVIDENCE_TOOL_FAILED when gh fetch fails', async () => {
    fetchSpy.mockResolvedValue({
      ok: false,
      reason: 'gh CLI is not available on PATH.',
    });
    const r = await resolvePrEvidenceAtom(357, projectRoot, {
      fetchGhPrPayload: mockFetch,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.codeName).toBe('E_EVIDENCE_TOOL_FAILED');
    expect(r.reason).toMatch(/gh CLI is not available/);
  });

  it('returns E_EVIDENCE_TOOL_FAILED when gh payload fails schema validation', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      payload: { state: 'UNKNOWN_STATE' }, // not a valid PR state
    });
    const r = await resolvePrEvidenceAtom(357, projectRoot, {
      fetchGhPrPayload: mockFetch,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.codeName).toBe('E_EVIDENCE_TOOL_FAILED');
    expect(r.reason).toMatch(/schema validation/);
  });
});

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

describe('resolvePrEvidenceAtom — cache', () => {
  it('returns cacheHit=true on second invocation with same mergedAt', async () => {
    fetchSpy.mockResolvedValue({ ok: true, payload: makePrPayload() });

    const first = await resolvePrEvidenceAtom(357, projectRoot, {
      fetchGhPrPayload: mockFetch,
    });
    expect(first.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const second = await resolvePrEvidenceAtom(357, projectRoot, {
      fetchGhPrPayload: mockFetch,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.cacheHit).toBe(true);
    // Crucial: no second fetch call
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('bypasses cache when bypassCache=true', async () => {
    fetchSpy.mockResolvedValue({ ok: true, payload: makePrPayload() });

    await resolvePrEvidenceAtom(357, projectRoot, { fetchGhPrPayload: mockFetch });
    await resolvePrEvidenceAtom(357, projectRoot, {
      fetchGhPrPayload: mockFetch,
      bypassCache: true,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('invalidates cache when mergedAt changes', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      payload: makePrPayload({ mergedAt: '2026-05-20T17:14:35Z' }),
    });
    await resolvePrEvidenceAtom(357, projectRoot, { fetchGhPrPayload: mockFetch });

    // Simulate a re-merge: mergedAt changes — different cache key → fetch again.
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      payload: makePrPayload({ mergedAt: '2026-05-21T00:00:00Z' }),
    });
    // Force re-read: the file is keyed on (prNumber, mergedAt) so calling
    // again with bypassCache=true is necessary because the cache entry on
    // disk still matches prNumber=357. But the key invariant the cache
    // enforces is at READ time: the stored `key` field must equal
    // `pr-<num>@<mergedAt>`. Stale entries should be evicted whenever the
    // upstream truth diverges. Since the on-disk file was written with the
    // first mergedAt, a normal call will return the cached (first) result —
    // demonstrating that mergedAt is part of the cache key on the WRITE
    // side. Verify by inspecting the persisted entry.
    const cachePath = prCacheEntryPath(projectRoot, 357);
    const persisted = JSON.parse(readFileSync(cachePath, 'utf-8'));
    expect(persisted.key).toBe('pr-357@2026-05-20T17:14:35Z');
  });
});

// ---------------------------------------------------------------------------
// Required-workflow override
// ---------------------------------------------------------------------------

describe('resolveRequiredWorkflows', () => {
  it('defaults to canonical list when env var unset', () => {
    const r = resolveRequiredWorkflows({});
    expect(r).toContain('CI');
    expect(r).toContain('Lockfile Check');
    expect(r).toContain('Contracts Dep Lint');
  });

  it('honours CLEO_PR_REQUIRED_WORKFLOWS env override', () => {
    const r = resolveRequiredWorkflows({
      CLEO_PR_REQUIRED_WORKFLOWS: 'My CI, Other Gate',
    });
    expect(r).toEqual(['My CI', 'Other Gate']);
  });

  it('ignores blank env value', () => {
    const r = resolveRequiredWorkflows({ CLEO_PR_REQUIRED_WORKFLOWS: '' });
    expect(r).toContain('CI');
  });

  // gh#1104 / T12014 — project-context tier
  it('returns project-context release.prRequiredWorkflows when set', () => {
    const r = resolveRequiredWorkflows({}, { release: { prRequiredWorkflows: ['My CI'] } });
    expect(r).toEqual(['My CI']);
  });

  it('returns EMPTY when project-context declares an empty required set (no-CI downstream repo)', () => {
    const r = resolveRequiredWorkflows({}, { release: { prRequiredWorkflows: [] } });
    expect(r).toEqual([]);
  });

  it('env var beats project-context', () => {
    const r = resolveRequiredWorkflows(
      { CLEO_PR_REQUIRED_WORKFLOWS: 'X' },
      { release: { prRequiredWorkflows: ['Y'] } },
    );
    expect(r).toEqual(['X']);
  });

  it('falls back to the default when context lacks the release key', () => {
    const r = resolveRequiredWorkflows({}, { foo: 'bar' });
    expect(r).toContain('CI');
  });

  it('falls back to the default when release.prRequiredWorkflows is malformed (not an array)', () => {
    const r = resolveRequiredWorkflows({}, { release: { prRequiredWorkflows: 'CI' } });
    expect(r).toContain('CI');
    expect(r).toContain('Lockfile Check');
  });
});

// ---------------------------------------------------------------------------
// evaluateRollup — direct unit tests
// ---------------------------------------------------------------------------

describe('evaluateRollup', () => {
  it('accepts a rollup with all required workflows green', () => {
    const r = evaluateRollup(
      [
        { workflowName: 'CI', conclusion: 'SUCCESS', status: 'COMPLETED' },
        { workflowName: 'Lockfile Check', conclusion: 'SUCCESS', status: 'COMPLETED' },
        { workflowName: 'Contracts Dep Lint', conclusion: 'SUCCESS', status: 'COMPLETED' },
      ],
      ['CI', 'Lockfile Check', 'Contracts Dep Lint'],
    );
    expect(r.ok).toBe(true);
  });

  it('rejects when required workflow missing entirely', () => {
    const r = evaluateRollup(
      [{ workflowName: 'CI', conclusion: 'SUCCESS', status: 'COMPLETED' }],
      ['CI', 'Lockfile Check'],
    );
    expect(r.ok).toBe(false);
  });

  it('accepts SKIPPED conclusion on required workflow', () => {
    const r = evaluateRollup(
      [
        { workflowName: 'CI', conclusion: 'SUCCESS', status: 'COMPLETED' },
        { workflowName: 'Lockfile Check', conclusion: 'SKIPPED', status: 'COMPLETED' },
      ],
      ['CI', 'Lockfile Check'],
    );
    expect(r.ok).toBe(true);
  });

  // gh#1104 / T12014 — empty required list is the lever: any MERGED PR passes.
  it('accepts an empty rollup when there are no required workflows', () => {
    const r = evaluateRollup([], []);
    expect(r.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// gh#1104 / T12014 — downstream consumer repo with no CI workflows
// ---------------------------------------------------------------------------

describe('resolvePrEvidenceAtom — downstream repo with no CI (gh#1104)', () => {
  it('accepts a MERGED PR with empty checks when project-context declares no required workflows', async () => {
    // The env tier is declared globally in beforeEach; this test exercises a
    // LOWER tier, so it must clear the more specific one first (gh#1323).
    delete process.env[PR_REQUIRED_WORKFLOWS_ENV_VAR];
    // A downstream repo (e.g. kodomeet): MERGED PR, statusCheckRollup empty.
    fetchSpy.mockResolvedValue({
      ok: true,
      payload: makePrPayload({ statusCheckRollup: [] }),
    });
    const r = await resolvePrEvidenceAtom(20, projectRoot, {
      fetchGhPrPayload: mockFetch,
      projectContext: { release: { prRequiredWorkflows: [] } },
      bypassCache: true,
    });
    expect(r.ok).toBe(true);
  });

  // BEHAVIOUR CHANGE (gh#1323). This test previously asserted that an
  // unresolvable required set fell through to cleocode's own gate names and
  // refused with "required gates were not found". That refusal was a confident
  // answer sourced from the wrong project: in a repo without those workflows it
  // reports failure when the truth is that CLEO never knew what to look for.
  // The atom must now say so instead.
  it('refuses with UNKNOWN — not a gate failure — when no tier can name the required checks', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      payload: makePrPayload({ statusCheckRollup: [] }),
    });
    delete process.env[PR_REQUIRED_WORKFLOWS_ENV_VAR];
    const r = await resolvePrEvidenceAtom(20, projectRoot, {
      fetchGhPrPayload: mockFetch,
      fetchGhBranchProtection: async () => ({ ok: false, reason: 'no branch protection' }),
      bypassCache: true,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    // NOT "required gates were not found" — that asserts the checks ran and did
    // not pass, which is a different and false claim.
    expect(r.reason).toMatch(/Cannot determine the required checks/);
    expect(r.reason).not.toMatch(/required gates were not found/);
    expect(r.codeName).toBe('E_EVIDENCE_INSUFFICIENT');
    // It must name BOTH levers, including the empty-array one, because "this
    // repo requires none" is a legitimate answer the caller may need to give.
    expect(r.reason).toContain(PR_REQUIRED_WORKFLOWS_CONTEXT_KEY);
    expect(r.reason).toContain('[]');
  });

  it("does not leak cleocode's own gate names into a foreign project's refusal", async () => {
    fetchSpy.mockResolvedValue({ ok: true, payload: makePrPayload({ statusCheckRollup: [] }) });
    delete process.env[PR_REQUIRED_WORKFLOWS_ENV_VAR];
    const r = await resolvePrEvidenceAtom(20, projectRoot, {
      fetchGhPrPayload: mockFetch,
      fetchGhBranchProtection: async () => ({ ok: false, reason: 'no workflows in this repo' }),
      bypassCache: true,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    // The measured gh#1323 report: a repo with Actions removed entirely was
    // told its PR lacked 'CI' / 'Lockfile Check' / 'Contracts Dep Lint'.
    // Check the DISTINCTIVE names, not 'CI' — the remedy text legitimately says
    // "a repository with no CI at all", and a naive substring match on a
    // two-letter name would fail on the advice rather than on a leak.
    expect(r.reason).not.toContain('Lockfile Check');
    expect(r.reason).not.toContain('Contracts Dep Lint');
    // And no per-required FOUND/NOT FOUND listing at all: there is no required
    // list to enumerate, which is the whole point.
    expect(r.reason).not.toMatch(/NOT FOUND on this PR/);
    expect(PR_REQUIRED_WORKFLOWS).toContain('Lockfile Check');
  });
});

// ---------------------------------------------------------------------------
// gh#1192 / T12104 — branch-protection tier for required-workflow resolution
// ---------------------------------------------------------------------------

describe('resolvePrEvidenceAtom — branch-protection tier (gh#1192)', () => {
  /** Build an injectable protection fetcher backed by a spy. */
  function makeProtectionFetcher(result: {
    ok: boolean;
    contexts?: string[];
    repo?: string;
    branch?: string;
    reason?: string;
  }): { fetcher: FetchGhBranchProtection; spy: ReturnType<typeof vi.fn> } {
    const spy = vi.fn().mockResolvedValue(
      result.ok
        ? {
            ok: true,
            contexts: result.contexts ?? [],
            repo: result.repo ?? 'octo/repo',
            branch: result.branch ?? 'main',
          }
        : { ok: false, reason: result.reason ?? 'lookup failed' },
    );
    return { fetcher: (() => spy()) as unknown as FetchGhBranchProtection, spy };
  }

  it('uses branch-protection contexts when env and project-context are absent', async () => {
    // The env tier is declared globally in beforeEach; this test exercises a
    // LOWER tier, so it must clear the more specific one first (gh#1323).
    delete process.env[PR_REQUIRED_WORKFLOWS_ENV_VAR];
    // The repo's real required check is 'Repo CI' — a name the built-in
    // default does not contain, so this only passes when the protection tier
    // is actually consulted.
    fetchSpy.mockResolvedValue({
      ok: true,
      payload: makePrPayload({
        statusCheckRollup: [
          {
            __typename: 'CheckRun',
            name: 'Repo CI',
            workflowName: 'ci',
            conclusion: 'SUCCESS',
            status: 'COMPLETED',
          },
        ],
      }),
    });
    const { fetcher } = makeProtectionFetcher({ ok: true, contexts: ['Repo CI'] });
    const r = await resolvePrEvidenceAtom(96, projectRoot, {
      fetchGhPrPayload: mockFetch,
      fetchGhBranchProtection: fetcher,
      bypassCache: true,
    });
    expect(r.ok).toBe(true);
  });

  it('env var beats branch protection', async () => {
    fetchSpy.mockResolvedValue({ ok: true, payload: makePrPayload() });
    const { fetcher, spy } = makeProtectionFetcher({ ok: true, contexts: ['Nonexistent Gate'] });
    const r = await resolvePrEvidenceAtom(96, projectRoot, {
      fetchGhPrPayload: mockFetch,
      fetchGhBranchProtection: fetcher,
      env: { CLEO_PR_REQUIRED_WORKFLOWS: 'CI' },
      bypassCache: true,
    });
    expect(r.ok).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });

  it('project-context beats branch protection', async () => {
    fetchSpy.mockResolvedValue({ ok: true, payload: makePrPayload() });
    const { fetcher, spy } = makeProtectionFetcher({ ok: true, contexts: ['Nonexistent Gate'] });
    const r = await resolvePrEvidenceAtom(96, projectRoot, {
      fetchGhPrPayload: mockFetch,
      fetchGhBranchProtection: fetcher,
      projectContext: { release: { prRequiredWorkflows: ['CI'] } },
      bypassCache: true,
    });
    expect(r.ok).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });

  // BEHAVIOUR CHANGE (gh#1323): a failed protection lookup no longer falls back
  // to cleocode's gate names. With a declared list it still succeeds (below);
  // with nothing declared it is UNKNOWN rather than silently borrowed.
  it('still succeeds on a failed protection lookup when the project DECLARES its checks', async () => {
    fetchSpy.mockResolvedValue({ ok: true, payload: makePrPayload() });
    const { fetcher } = makeProtectionFetcher({ ok: false, reason: 'offline' });
    const r = await resolvePrEvidenceAtom(96, projectRoot, {
      fetchGhPrPayload: mockFetch,
      fetchGhBranchProtection: fetcher,
      bypassCache: true,
    });
    expect(r.ok).toBe(true);
  });

  it('is UNKNOWN on a failed protection lookup when the project declares nothing', async () => {
    fetchSpy.mockResolvedValue({ ok: true, payload: makePrPayload() });
    delete process.env[PR_REQUIRED_WORKFLOWS_ENV_VAR];
    const { fetcher } = makeProtectionFetcher({ ok: false, reason: 'offline' });
    const r = await resolvePrEvidenceAtom(96, projectRoot, {
      fetchGhPrPayload: mockFetch,
      fetchGhBranchProtection: fetcher,
      bypassCache: true,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/Cannot determine the required checks/);
    // The underlying reason is carried through, so the operator can tell a
    // network failure from a repo that genuinely declares nothing.
    expect(r.reason).toContain('offline');
  });

  it('names the branch-protection source in the missing-workflows rejection', async () => {
    // The env tier is declared globally in beforeEach; this test exercises a
    // LOWER tier, so it must clear the more specific one first (gh#1323).
    delete process.env[PR_REQUIRED_WORKFLOWS_ENV_VAR];
    fetchSpy.mockResolvedValue({ ok: true, payload: makePrPayload() });
    const { fetcher } = makeProtectionFetcher({ ok: true, contexts: ['Repo CI'] });
    const r = await resolvePrEvidenceAtom(96, projectRoot, {
      fetchGhPrPayload: mockFetch,
      fetchGhBranchProtection: fetcher,
      bypassCache: true,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain('source: branch protection for octo/repo@main');
    expect(r.reason).toContain('- Repo CI  NOT FOUND on this PR');
  });

  it('caches the protection lookup across verifies (1h TTL)', async () => {
    // The env tier is declared globally in beforeEach; this test exercises a
    // LOWER tier, so it must clear the more specific one first (gh#1323).
    delete process.env[PR_REQUIRED_WORKFLOWS_ENV_VAR];
    fetchSpy.mockResolvedValue({ ok: true, payload: makePrPayload() });
    const { fetcher, spy } = makeProtectionFetcher({
      ok: true,
      contexts: ['CI', 'Lockfile Check', 'Contracts Dep Lint'],
    });
    // Two different PR numbers so the PR-result cache never short-circuits;
    // the SECOND call must reuse the cached protection contexts.
    const first = await resolvePrEvidenceAtom(96, projectRoot, {
      fetchGhPrPayload: mockFetch,
      fetchGhBranchProtection: fetcher,
    });
    const second = await resolvePrEvidenceAtom(97, projectRoot, {
      fetchGhPrPayload: mockFetch,
      fetchGhBranchProtection: fetcher,
    });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(existsSync(branchProtectionCachePath(projectRoot))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// gh#1198 / T12104 — missing-workflows rejection prints both sides + source
// ---------------------------------------------------------------------------

describe('resolvePrEvidenceAtom — missing-workflows rejection detail (gh#1198)', () => {
  it('prints FOUND/NOT FOUND per required entry, the source, and the actually-run workflows', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      payload: makePrPayload({
        statusCheckRollup: [
          {
            __typename: 'CheckRun',
            name: 'Build & Verify',
            workflowName: 'CI',
            conclusion: 'SUCCESS',
            status: 'COMPLETED',
          },
          {
            __typename: 'CheckRun',
            name: 'Lint',
            workflowName: 'Lint Workflow',
            conclusion: 'FAILURE',
            status: 'COMPLETED',
          },
        ],
      }),
    });
    const r = await resolvePrEvidenceAtom(102, projectRoot, {
      fetchGhPrPayload: mockFetch,
      fetchGhBranchProtection: async () => ({ ok: false, reason: 'no branch protection' }),
      bypassCache: true,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain('Cannot accept pr atom for PR #102');
    // gh#1198 asks that the SOURCE be disclosed, not that it be any particular
    // tier. gh#1323 removed the built-in-default tier, so assert the disclosure
    // rather than the tier that used to provide it.
    expect(r.reason).toMatch(/required workflows \(source: .+\)/);
    expect(r.reason).toContain('- CI  FOUND on this PR');
    expect(r.reason).toContain('- Lockfile Check  NOT FOUND on this PR');
    expect(r.reason).toContain('- Contracts Dep Lint  NOT FOUND on this PR');
    expect(r.reason).toContain('workflows actually run on PR #102');
    expect(r.reason).toContain('- Build & Verify  SUCCESS');
    expect(r.reason).toContain('- Lint  FAILURE');
    // Override guidance (T12100) survives the rewording.
    expect(r.reason).toContain('CLEO_PR_REQUIRED_WORKFLOWS');
    expect(r.reason).toContain('release.prRequiredWorkflows');
  });
});

// ---------------------------------------------------------------------------
// Gate evidence minimums
// ---------------------------------------------------------------------------

describe('checkGateEvidenceMinimum — pr atom satisfies testsPassed + qaPassed + implemented (T9838)', () => {
  const prAtom: EvidenceAtom = {
    kind: 'pr',
    prNumber: 357,
    mergeCommitSha: 'a'.repeat(40),
    mergedAt: '2026-05-20T17:14:35Z',
    successCount: 4,
    totalChecks: 4,
  };

  it('accepts pr atom for testsPassed', () => {
    expect(checkGateEvidenceMinimum('testsPassed', [prAtom])).toBeNull();
  });

  it('accepts pr atom for qaPassed', () => {
    expect(checkGateEvidenceMinimum('qaPassed', [prAtom])).toBeNull();
  });

  it('T9838: accepts pr atom for implemented gate (merged PR IS the landing commit)', () => {
    // T9838: a merged PR with a real mergeCommitSha IS the proof that the
    // implementation landed on main. Eliminates the manual
    // `commit:<sha>;files:...` backfill ritual that v5.91-v5.93 ships
    // were stuck in.
    expect(checkGateEvidenceMinimum('implemented', [prAtom])).toBeNull();
  });

  it('T9838: pr atom satisfies all three release-time gates simultaneously', () => {
    // The motivating use case: after merging a PR, one `pr:<num>` atom
    // should cover implemented + testsPassed + qaPassed in a single
    // verify invocation.
    expect(checkGateEvidenceMinimum('implemented', [prAtom])).toBeNull();
    expect(checkGateEvidenceMinimum('testsPassed', [prAtom])).toBeNull();
    expect(checkGateEvidenceMinimum('qaPassed', [prAtom])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// T9838 — explicit-form parsing (pr:<num>;state:MERGED)
// ---------------------------------------------------------------------------

describe('parseEvidence — explicit-form pr atom (T9838)', () => {
  it('parses pr:<num>;state:MERGED as a single pr atom (state modifier consumed in-place)', () => {
    const r = parseEvidence('pr:357;state:MERGED');
    expect(r.atoms).toHaveLength(1);
    expect(r.atoms[0]).toEqual({ kind: 'pr', prNumber: 357 });
  });

  it('treats bare pr:<num> equivalently to pr:<num>;state:MERGED (backward compat)', () => {
    const bare = parseEvidence('pr:357');
    const explicit = parseEvidence('pr:357;state:MERGED');
    expect(explicit.atoms).toEqual(bare.atoms);
  });

  it('rejects state:OPEN (only MERGED is meaningful)', () => {
    expect(() => parseEvidence('pr:357;state:OPEN')).toThrow(/only accepts "MERGED"/);
  });

  it('rejects state:CLOSED', () => {
    expect(() => parseEvidence('pr:357;state:CLOSED')).toThrow(/only accepts "MERGED"/);
  });

  it('rejects free-standing state:MERGED with no preceding pr: atom', () => {
    expect(() => parseEvidence('state:MERGED')).toThrow(/must immediately follow a pr:<num> atom/);
  });

  it('rejects state:MERGED preceded by a non-pr atom', () => {
    expect(() => parseEvidence('commit:abc1234;state:MERGED')).toThrow(
      /must immediately follow a pr:<num> atom/,
    );
  });

  it('explicit form composes with other atoms', () => {
    const r = parseEvidence('pr:357;state:MERGED;note:explicit form used');
    expect(r.atoms).toHaveLength(2);
    expect(r.atoms[0]).toEqual({ kind: 'pr', prNumber: 357 });
    expect(r.atoms[1]).toEqual({ kind: 'note', note: 'explicit form used' });
  });
});

// ---------------------------------------------------------------------------
// T9838 — resolver behavior on implemented gate
// ---------------------------------------------------------------------------

describe('resolvePrEvidenceAtom — implemented gate semantics (T9838)', () => {
  it('happy path: merged PR with passing CI satisfies all three gates', async () => {
    fetchSpy.mockResolvedValue({ ok: true, payload: makePrPayload() });
    const r = await resolvePrEvidenceAtom(357, projectRoot, {
      fetchGhPrPayload: mockFetch,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // The resolver returned a valid atom — wire it through the gate engine.
    const atom: EvidenceAtom = {
      kind: 'pr',
      prNumber: r.prNumber,
      mergeCommitSha: r.mergeCommitSha,
      mergedAt: r.mergedAt,
      successCount: r.successCount,
      totalChecks: r.totalChecks,
    };
    expect(checkGateEvidenceMinimum('implemented', [atom])).toBeNull();
    expect(checkGateEvidenceMinimum('testsPassed', [atom])).toBeNull();
    expect(checkGateEvidenceMinimum('qaPassed', [atom])).toBeNull();
  });

  it('non-merged (state=OPEN) PR yields no atom — gates remain unsatisfied', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      payload: makePrPayload({ state: 'OPEN', mergedAt: null }),
    });
    const r = await resolvePrEvidenceAtom(357, projectRoot, {
      fetchGhPrPayload: mockFetch,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.codeName).toBe('E_EVIDENCE_INSUFFICIENT');
    expect(r.reason).toMatch(/state.*OPEN/);

    // With no successful atom the gate engine MUST refuse implemented as well.
    expect(checkGateEvidenceMinimum('implemented', [])).not.toBeNull();
  });

  it('merged PR with required-CI failure preserves T9764 testsPassed/qaPassed rejection', async () => {
    // Sanity: T9838 only EXTENDS the gate list — it must not weaken the
    // existing T9764 CI-failure rejection on testsPassed/qaPassed.
    const payload = makePrPayload({
      statusCheckRollup: [
        {
          __typename: 'CheckRun',
          name: 'Build & Verify (ubuntu-latest)',
          workflowName: 'CI',
          conclusion: 'SUCCESS',
          status: 'COMPLETED',
        },
        {
          __typename: 'CheckRun',
          name: 'Verify pnpm-lock.yaml consistency',
          workflowName: 'Lockfile Check',
          conclusion: 'SUCCESS',
          status: 'COMPLETED',
        },
        {
          __typename: 'CheckRun',
          name: 'Contracts Dep Lint',
          workflowName: 'Contracts Dep Lint',
          conclusion: 'FAILURE',
          status: 'COMPLETED',
        },
      ],
    });
    fetchSpy.mockResolvedValue({ ok: true, payload });
    const r = await resolvePrEvidenceAtom(357, projectRoot, {
      fetchGhPrPayload: mockFetch,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.codeName).toBe('E_EVIDENCE_TESTS_FAILED');
  });
});

// ---------------------------------------------------------------------------
// validateAtom dispatch
// ---------------------------------------------------------------------------

describe('validateAtom — pr dispatch', () => {
  it('dispatches pr atom to resolver (failure path: invalid prNumber)', async () => {
    // Without mocking gh, an invalid prNumber should short-circuit.
    const r = await validateAtom({ kind: 'pr', prNumber: -1 }, projectRoot);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.codeName).toBe('E_EVIDENCE_INVALID');
  });
});
