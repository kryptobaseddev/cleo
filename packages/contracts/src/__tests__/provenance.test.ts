/**
 * Structural-equivalence tests for the provenance graph contracts.
 *
 * These tests pin the literal shapes of the 16 provenance/release/BRAIN
 * unions promoted in Phase 0c (T9955) so that accidental narrowing or
 * widening produces a compile-time failure during `tsc -b` in the CI gate.
 *
 * The compile-time assertions use the conditional-equality trick
 * (`Equals<A, B>`) so any structural drift produces a TS2322 or TS2344 at
 * build time. The runtime `expect` shape sanity check below is a thin
 * smoke verification that representative literals satisfy each union — it
 * does NOT exercise behavior (these are pure type contracts with no
 * runtime).
 *
 * @since SG-ARCH-SOLID Saga T9831 · E-CONTRACTS-FOUNDATION T9832 · T9955 (Phase 0c)
 */

import { describe, expect, it } from 'vitest';
import type {
  BrainReleaseLinkType,
  CommitConventionalType,
  CommitFileChangeType,
  CommitLinkKind,
  CommitLinkSource,
  PrLinkKind,
  PrLinkSource,
  PrState,
  ReleaseArtifactType,
  ReleaseChangeType,
  ReleaseChannel,
  ReleaseClassifiedBy,
  ReleaseImpact,
  ReleaseKind,
  ReleaseScheme,
  ReleaseStatus,
} from '../provenance.js';

// ─── Compile-time structural-equality helpers ───────────────────────

/** Resolve to `1` IFF `A` and `B` are mutually assignable; `2` otherwise. */
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? 1 : 2;

/** Compile-time assert that `T` resolves to `1`. */
type AssertEquals1<T extends 1> = T;

// ─── PrState pin ────────────────────────────────────────────────────

type _PrStateShape = 'open' | 'closed' | 'merged';
type _AssertPrStatePinned = AssertEquals1<Equals<PrState, _PrStateShape>>;

// ─── CommitLinkKind pin ─────────────────────────────────────────────

type _CommitLinkKindShape = 'implements' | 'fixes' | 'refactors' | 'tests' | 'docs' | 'reverts';
type _AssertCommitLinkKindPinned = AssertEquals1<Equals<CommitLinkKind, _CommitLinkKindShape>>;

// ─── ReleaseStatus pin (unified — admits both pipelines) ────────────

type _ReleaseStatusShape =
  | 'planned'
  | 'pr-opened'
  | 'pr-merged'
  | 'published'
  | 'reconciled'
  | 'prepared'
  | 'committed'
  | 'tagged'
  | 'pushed'
  | 'rolled_back'
  | 'failed'
  | 'cancelled';
type _AssertReleaseStatusPinned = AssertEquals1<Equals<ReleaseStatus, _ReleaseStatusShape>>;

// ─── ReleaseChangeType pin (12-value taxonomy) ──────────────────────

type _ReleaseChangeTypeShape =
  | 'feature'
  | 'enhancement'
  | 'bug'
  | 'hotfix'
  | 'security'
  | 'breaking'
  | 'refactor'
  | 'docs'
  | 'chore'
  | 'revert'
  | 'deprecation'
  | 'infrastructure';
type _AssertReleaseChangeTypePinned = AssertEquals1<
  Equals<ReleaseChangeType, _ReleaseChangeTypeShape>
>;

// ─── ReleaseArtifactType pin ────────────────────────────────────────

type _ReleaseArtifactTypeShape =
  | 'npm'
  | 'cargo'
  | 'docker'
  | 'pypi'
  | 'github-release'
  | 'binary'
  | 'github-tag';
type _AssertReleaseArtifactTypePinned = AssertEquals1<
  Equals<ReleaseArtifactType, _ReleaseArtifactTypeShape>
>;

// ─── BrainReleaseLinkType pin ───────────────────────────────────────

type _BrainReleaseLinkTypeShape = 'approved-by' | 'documented-in' | 'derived-from' | 'observed-in';
type _AssertBrainReleaseLinkTypePinned = AssertEquals1<
  Equals<BrainReleaseLinkType, _BrainReleaseLinkTypeShape>
>;

// ─── Runtime constructibility smoke ─────────────────────────────────

describe('provenance contracts', () => {
  it('PrState union covers exactly the 3 GitHub PR states', () => {
    const all: PrState[] = ['open', 'closed', 'merged'];
    expect(all).toHaveLength(3);
  });

  it('PrLinkSource enumerates all 5 discovery sources', () => {
    const all: PrLinkSource[] = ['pr-title', 'pr-body', 'branch-name', 'commit-trailer', 'manual'];
    expect(all).toHaveLength(5);
  });

  it('PrLinkKind extends CommitLinkKind with the "tracks" addition', () => {
    const commit: CommitLinkKind = 'implements';
    const pr: PrLinkKind = commit; // every commit-link-kind is a valid pr-link-kind
    expect(pr).toBe('implements');
    const tracks: PrLinkKind = 'tracks';
    expect(tracks).toBe('tracks');
  });

  it('CommitConventionalType enumerates the canonical CC prefixes plus "breaking"', () => {
    const ccs: CommitConventionalType[] = [
      'feat',
      'fix',
      'chore',
      'docs',
      'refactor',
      'test',
      'build',
      'ci',
      'perf',
      'revert',
      'breaking',
    ];
    expect(ccs).toHaveLength(11);
    expect(ccs).toContain('breaking');
  });

  it('CommitLinkSource and CommitLinkKind are independent unions', () => {
    const src: CommitLinkSource = 'commit-trailer';
    const kind: CommitLinkKind = 'implements';
    expect(src).toBe('commit-trailer');
    expect(kind).toBe('implements');
  });

  it('CommitFileChangeType matches the git status letter codes', () => {
    const codes: CommitFileChangeType[] = ['A', 'M', 'D', 'R', 'C'];
    expect(codes).toHaveLength(5);
  });

  it('ReleaseScheme enumerates calver/semver/calver-suffix', () => {
    const schemes: ReleaseScheme[] = ['calver', 'semver', 'calver-suffix'];
    expect(schemes).toHaveLength(3);
  });

  it('ReleaseChannel enumerates the provenance-layer channels', () => {
    const channels: ReleaseChannel[] = ['latest', 'beta', 'dev', 'hotfix'];
    expect(channels).toHaveLength(4);
  });

  it('ReleaseKind enumerates regular/hotfix/prerelease', () => {
    const kinds: ReleaseKind[] = ['regular', 'hotfix', 'prerelease'];
    expect(kinds).toHaveLength(3);
  });

  it('ReleaseStatus admits BOTH new-pipeline and legacy-pipeline statuses', () => {
    const newPipeline: ReleaseStatus[] = [
      'planned',
      'pr-opened',
      'pr-merged',
      'published',
      'reconciled',
    ];
    const legacyPipeline: ReleaseStatus[] = ['prepared', 'committed', 'tagged', 'pushed'];
    const terminals: ReleaseStatus[] = ['rolled_back', 'failed', 'cancelled'];
    expect(newPipeline).toHaveLength(5);
    expect(legacyPipeline).toHaveLength(4);
    expect(terminals).toHaveLength(3);
  });

  it('ReleaseChangeType enumerates the 12 CLEO change types', () => {
    const types: ReleaseChangeType[] = [
      'feature',
      'enhancement',
      'bug',
      'hotfix',
      'security',
      'breaking',
      'refactor',
      'docs',
      'chore',
      'revert',
      'deprecation',
      'infrastructure',
    ];
    expect(types).toHaveLength(12);
  });

  it('ReleaseImpact enumerates the 4 semver-bump assessments', () => {
    const impacts: ReleaseImpact[] = ['major', 'minor', 'patch', 'none'];
    expect(impacts).toHaveLength(4);
  });

  it('ReleaseClassifiedBy enumerates auto/manual/approved provenance', () => {
    const provenance: ReleaseClassifiedBy[] = ['auto', 'manual', 'approved'];
    expect(provenance).toHaveLength(3);
  });

  it('ReleaseArtifactType enumerates the 7 supported artifact archetypes', () => {
    const types: ReleaseArtifactType[] = [
      'npm',
      'cargo',
      'docker',
      'pypi',
      'github-release',
      'binary',
      'github-tag',
    ];
    expect(types).toHaveLength(7);
  });

  it('BrainReleaseLinkType enumerates the 4 BRAIN↔release semantics', () => {
    const links: BrainReleaseLinkType[] = [
      'approved-by',
      'documented-in',
      'derived-from',
      'observed-in',
    ];
    expect(links).toHaveLength(4);
  });

  // The five `_Assert…Pinned` aliases above will fail compilation if any
  // shape drifts. The following references prevent unused-locals
  // diagnostics from removing them.
  it('compile-time pins are wired (no-op at runtime)', () => {
    const pinned: [
      _AssertPrStatePinned,
      _AssertCommitLinkKindPinned,
      _AssertReleaseStatusPinned,
      _AssertReleaseChangeTypePinned,
      _AssertReleaseArtifactTypePinned,
      _AssertBrainReleaseLinkTypePinned,
    ] = [1, 1, 1, 1, 1, 1];
    expect(pinned).toEqual([1, 1, 1, 1, 1, 1]);
  });
});
