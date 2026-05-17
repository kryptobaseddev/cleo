/**
 * Tests for T9504 — tag-after-merge-confirmed fix.
 *
 * Validates that `pollPrMerged` correctly:
 *   - Polls `gh pr view --json state,mergeCommit` until `state === "MERGED"`
 *   - Returns the `mergeCommit.oid` from gh (NOT a re-derived HEAD SHA)
 *   - Times out and returns `null` when the PR never reaches MERGED state
 *
 * @task T9504
 */

import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pollPrMerged } from '../engine-ops.js';

// Mock node:child_process — spread actual module so transitive deps that use
// execFile (callback form, e.g. gate-runner.ts) still resolve correctly.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: vi.fn(),
    spawnSync: vi.fn(),
  };
});

const mockExecFileSync = vi.mocked(execFileSync);

describe('pollPrMerged (T9504)', () => {
  beforeEach(() => {
    mockExecFileSync.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('polls until state=MERGED and returns mergeCommit.oid', () => {
    // Call 1: OPEN, no merge commit yet
    // Call 2: OPEN, still no merge commit
    // Call 3: MERGED with a commit OID
    const mergeOid = 'abc123def456789012345678901234567890abcd';
    mockExecFileSync
      .mockReturnValueOnce(JSON.stringify({ state: 'OPEN', mergeCommit: null }) as never)
      .mockReturnValueOnce(JSON.stringify({ state: 'OPEN', mergeCommit: null }) as never)
      .mockReturnValueOnce(
        JSON.stringify({ state: 'MERGED', mergeCommit: { oid: mergeOid } }) as never,
      );

    const result = pollPrMerged('https://github.com/owner/repo/pull/42', {
      pollIntervalMs: 0, // no sleep in tests
      timeoutMs: 30_000,
    });

    expect(result).not.toBeNull();
    expect(result?.mergeCommitOid).toBe(mergeOid);

    // Verify gh was invoked 3 times with the correct args
    const ghCalls = mockExecFileSync.mock.calls.filter((call) => call[0] === 'gh');
    expect(ghCalls).toHaveLength(3);
    for (const call of ghCalls) {
      expect(call[1]).toEqual([
        'pr',
        'view',
        'https://github.com/owner/repo/pull/42',
        '--json',
        'state,mergeCommit',
      ]);
    }
  });

  it('returns mergeCommit.oid — NOT a re-derived git rev-parse HEAD', () => {
    // The whole point of T9504: the OID comes from gh, not from a subsequent
    // `git rev-parse HEAD` which races against merge propagation.
    const mergeOid = 'deadbeef1234567890abcdef1234567890abcdef';
    mockExecFileSync.mockReturnValueOnce(
      JSON.stringify({ state: 'MERGED', mergeCommit: { oid: mergeOid } }) as never,
    );

    const result = pollPrMerged('https://github.com/owner/repo/pull/99', {
      pollIntervalMs: 0,
      timeoutMs: 5_000,
    });

    expect(result?.mergeCommitOid).toBe(mergeOid);

    // Verify we NEVER called `git rev-parse HEAD` inside the poll loop
    const gitRevParseCalls = mockExecFileSync.mock.calls.filter(
      (call) => call[0] === 'git' && Array.isArray(call[1]) && call[1].includes('rev-parse'),
    );
    expect(gitRevParseCalls).toHaveLength(0);
  });

  it('returns null when timeout elapses before MERGED', () => {
    // gh always returns OPEN — simulates a hung merge
    mockExecFileSync.mockReturnValue(JSON.stringify({ state: 'OPEN', mergeCommit: null }) as never);

    const result = pollPrMerged('https://github.com/owner/repo/pull/7', {
      pollIntervalMs: 0,
      // Very short timeout so the test doesn't block
      timeoutMs: 1,
    });

    expect(result).toBeNull();
  });

  it('handles transient gh CLI errors by continuing to poll', () => {
    // First call throws (network glitch), second returns MERGED
    const mergeOid = 'cafebabe0000000000000000000000000000cafe';
    mockExecFileSync
      .mockImplementationOnce(() => {
        throw new Error('gh: connection refused');
      })
      .mockReturnValueOnce(
        JSON.stringify({ state: 'MERGED', mergeCommit: { oid: mergeOid } }) as never,
      );

    const result = pollPrMerged('https://github.com/owner/repo/pull/55', {
      pollIntervalMs: 0,
      timeoutMs: 10_000,
    });

    expect(result?.mergeCommitOid).toBe(mergeOid);
  });

  it('handles malformed JSON from gh by continuing to poll', () => {
    const mergeOid = '1234567890abcdef1234567890abcdef12345678';
    mockExecFileSync
      .mockReturnValueOnce('not-json' as never)
      .mockReturnValueOnce(
        JSON.stringify({ state: 'MERGED', mergeCommit: { oid: mergeOid } }) as never,
      );

    const result = pollPrMerged('https://github.com/owner/repo/pull/100', {
      pollIntervalMs: 0,
      timeoutMs: 10_000,
    });

    expect(result?.mergeCommitOid).toBe(mergeOid);
  });

  it('does not accept MERGED state with empty mergeCommit.oid', () => {
    // GitHub can momentarily return state=MERGED before mergeCommit is populated.
    // We must keep polling until the OID is non-empty.
    const mergeOid = 'ffffffff0000000000000000000000000000ffff';
    mockExecFileSync
      .mockReturnValueOnce(
        // state=MERGED but oid is empty string
        JSON.stringify({ state: 'MERGED', mergeCommit: { oid: '' } }) as never,
      )
      .mockReturnValueOnce(
        JSON.stringify({ state: 'MERGED', mergeCommit: { oid: mergeOid } }) as never,
      );

    const result = pollPrMerged('https://github.com/owner/repo/pull/200', {
      pollIntervalMs: 0,
      timeoutMs: 10_000,
    });

    expect(result?.mergeCommitOid).toBe(mergeOid);
  });
});
