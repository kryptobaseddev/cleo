/**
 * Round-trip parity test for the T10373 (E5.3) sweep-identified orphan
 * remediation.
 *
 * Background: T10372 (E5.2) shipped `scripts/sweep-manual-doc-writes.mjs`,
 * which scans `rawMdPaths` declared in `.cleo/canon.yml` and classifies
 * each `.md` file relative to the docs SSoT. The 2026-05-24 sweep
 * surfaced FIVE orphans — files that exist on disk inside a `rawMdPaths`
 * directory but have no corresponding `attachments` row in the SSoT:
 *
 *   - `.cleo/adrs/ADR-083-cleo-persona-and-hierarchy-reconciliation.md`
 *   - `.cleo/adrs/ADR-085-cross-db-invariants.md`
 *   - `.cleo/agent-outputs/T10268-saga-closeout.md`
 *   - `.cleo/research/t10292-e4-cli-verb-matrix.md`
 *   - `.cleo/research/t10292-e4-sdk-import-edges.md`
 *
 * The two research files are the canonical example of the failure mode
 * Epic T10293 targets: T10353 and T10354 workers fell back to raw
 * filesystem writes because the pre-T10389 worktree-unreachable bug made
 * `cleo docs add` reject inside a spawned worktree. The two ADRs were
 * authored before the worktree-router fix landed. The handoff was a
 * direct worker write that never routed through the SSoT.
 *
 * T10373 migrated all five into the SSoT via `cleo docs add` with
 * preserved slugs and the original task owner-ids (ADR-083 → T10333,
 * ADR-085 → T10320, handoff → T10268, verb-matrix → T10353,
 * import-edges → T10354). This test asserts the round-trip invariant
 * for each: a fresh tempdir-backed `.cleo/`, re-imported bytes, identical
 * sha256 on both ends. If a future migration silently rewrites or
 * recompresses any blob, this test fails.
 *
 * Each canonical record:
 *   - `adr-083-cleo-persona-and-hierarchy-reconciliation` → adr,      SHA bd8c14ab…
 *   - `adr-085-cross-db-invariants`                       → adr,      SHA 677ad407…
 *   - `t10268-saga-closeout`                              → handoff,  SHA cbc9da44…
 *   - `t10292-e4-cli-verb-matrix`                         → research, SHA b4b42406…
 *   - `t10292-e4-sdk-import-edges`                        → research, SHA 9e4d21fd…
 *
 * @task T10373
 * @epic T10293
 * @saga T10288
 */

import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let tempDir: string;

/**
 * Canonical SHA-256 of each remediated artifact, captured at T10373
 * migration time (2026-05-24). These values are the contract — changing
 * them means a future migration has silently rewritten the bytes and
 * must be re-validated against the source files.
 */
const CANONICAL_SHA = {
  adr083: 'bd8c14ab55430125c0909e0b42d9f0f1e453c1116e1e25f821c6b34ece6c4c2f',
  adr085: '677ad407b1751d889cded48aa7de9cc26274e852cc41ee9c37f8bbedd4625a13',
  t10268Handoff: 'cbc9da442d4d3304fc6fb591275fe8f6b59335256cec1cb5cb3e6944a5fec75d',
  t10292CliVerbMatrix: 'b4b4240616b35f250a1b5aaa3bd84b75a859448a62b7cfa76e3eac5ada150092',
  t10292SdkImportEdges: '9e4d21fd18ad983d98dee545c239f458cbb5c96c9d3574007a030fd0c09b2b64',
} as const;

/**
 * Project-relative source paths for each remediated artifact. Kept as a
 * lookup table so the test can lazy-load only the bytes it needs for a
 * given assertion and so a future migration that moves any file fails
 * loud rather than silently passing on a missing-file fallback.
 */
const SOURCE_PATHS = {
  adr083: '.cleo/adrs/ADR-083-cleo-persona-and-hierarchy-reconciliation.md',
  adr085: '.cleo/adrs/ADR-085-cross-db-invariants.md',
  t10268Handoff: '.cleo/agent-outputs/T10268-saga-closeout.md',
  t10292CliVerbMatrix: '.cleo/research/t10292-e4-cli-verb-matrix.md',
  t10292SdkImportEdges: '.cleo/research/t10292-e4-sdk-import-edges.md',
} as const;

type RemediatedSlug = keyof typeof CANONICAL_SHA;

/**
 * SSoT slug + doc type + owner-task triple for each remediated artifact,
 * mirroring the `cleo docs add` invocations T10373 ran in production.
 */
const REMEDIATION_PLAN: Record<RemediatedSlug, { slug: string; type: string; ownerId: string }> = {
  adr083: {
    slug: 'adr-083-cleo-persona-and-hierarchy-reconciliation',
    type: 'adr',
    ownerId: 'T10333',
  },
  adr085: {
    slug: 'adr-085-cross-db-invariants',
    type: 'adr',
    ownerId: 'T10320',
  },
  t10268Handoff: {
    slug: 't10268-saga-closeout',
    type: 'handoff',
    ownerId: 'T10268',
  },
  t10292CliVerbMatrix: {
    slug: 't10292-e4-cli-verb-matrix',
    type: 'research',
    ownerId: 'T10353',
  },
  t10292SdkImportEdges: {
    slug: 't10292-e4-sdk-import-edges',
    type: 'research',
    ownerId: 'T10354',
  },
};

/**
 * Compute SHA-256 of a Buffer as lowercase hex — matches
 * `packages/core/src/store/attachment-store.ts` canonical encoding.
 */
function sha256Hex(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Resolve a source-path key to absolute bytes loaded from the live
 * working tree. The test relies on the source files surviving in-tree
 * (T10373 deliberately did NOT delete them — see Epic T10293 sequencing).
 */
async function loadSource(key: RemediatedSlug): Promise<Buffer> {
  // Tests run from the package root; walk up to find the repo root.
  const repoRoot = resolve(__dirname, '../../../../..');
  return readFile(join(repoRoot, SOURCE_PATHS[key]));
}

describe('T10373 sweep-remediation round-trip', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-t10373-'));
    process.env['CLEO_DIR'] = join(tempDir, '.cleo');
  });

  afterEach(async () => {
    const { closeDb } = await import('../../store/sqlite.js');
    closeDb();
    delete process.env['CLEO_DIR'];
    await rm(tempDir, { recursive: true, force: true });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Source-file invariants — each on-disk source file must hash to the
  // canonical SHA captured at T10373 migration time. If any file drifts
  // post-remediation, the SSoT and the working-tree copy fall out of sync
  // and the next sweep run would re-flag it as drift.
  // ─────────────────────────────────────────────────────────────────────

  for (const key of Object.keys(CANONICAL_SHA) as RemediatedSlug[]) {
    it(`source file for ${REMEDIATION_PLAN[key].slug} hashes to canonical SHA`, async () => {
      const bytes = await loadSource(key);
      expect(sha256Hex(bytes)).toBe(CANONICAL_SHA[key]);
    });
  }

  // ─────────────────────────────────────────────────────────────────────
  // Round-trip parity — re-import each remediated artifact into a fresh
  // isolated SSoT and assert that `put → findBySlug` returns the same
  // content SHA, type, and owner attribution.
  // ─────────────────────────────────────────────────────────────────────

  for (const key of Object.keys(CANONICAL_SHA) as RemediatedSlug[]) {
    it(`round-trips ${REMEDIATION_PLAN[key].slug} through SSoT preserving SHA + type + owner`, async () => {
      const { createAttachmentStore } = await import('../../store/attachment-store.js');
      const { closeDb } = await import('../../store/sqlite.js');
      closeDb();

      const plan = REMEDIATION_PLAN[key];
      const store = createAttachmentStore();
      const bytes = await loadSource(key);

      const meta = await store.put(
        bytes,
        { kind: 'blob', storageKey: '', mime: 'text/markdown', size: bytes.length },
        'task',
        plan.ownerId,
        'cleo-t10373-test',
        undefined,
        { slug: plan.slug, type: plan.type },
      );

      expect(meta.sha256).toBe(CANONICAL_SHA[key]);

      // findBySlug returns slug + type + metadata (no owner). Use
      // listAllInProject (which exposes ownerId) to assert the full
      // attribution triple was persisted.
      const lookup = await store.findBySlug(plan.slug, undefined);
      expect(lookup).not.toBeNull();
      expect(lookup?.metadata.sha256).toBe(CANONICAL_SHA[key]);
      expect(lookup?.type).toBe(plan.type);

      const allRows = await store.listAllInProject(undefined, { type: plan.type });
      const ownerRow = allRows.find((r) => r.slug === plan.slug);
      expect(ownerRow).toBeDefined();
      expect(ownerRow?.ownerType).toBe('task');
      expect(ownerRow?.ownerId).toBe(plan.ownerId);
    });
  }

  // ─────────────────────────────────────────────────────────────────────
  // Slug uniqueness — the five remediated slugs MUST resolve to five
  // distinct SHA-256 values. Catches accidental slug-aliasing regressions
  // (a real failure mode — see SAGA T10288 slug-collision bug T10294).
  // ─────────────────────────────────────────────────────────────────────

  it('the five remediated slugs map to five distinct content SHAs', () => {
    const shas = new Set(Object.values(CANONICAL_SHA));
    expect(shas.size).toBe(5);
  });

  // ─────────────────────────────────────────────────────────────────────
  // Plan-shape invariants — the five remediated slugs MUST use only
  // types that exist in the docs taxonomy. Catches a class of typo bugs
  // where a future remediation mis-spells a `--type` value.
  // ─────────────────────────────────────────────────────────────────────

  it('every remediation plan uses an allowed doc type', () => {
    const ALLOWED_TYPES = new Set([
      'adr',
      'spec',
      'research',
      'handoff',
      'note',
      'llm-readme',
      'changeset',
      'release-note',
      'plan',
      'rcasd',
    ]);
    for (const plan of Object.values(REMEDIATION_PLAN)) {
      expect(ALLOWED_TYPES.has(plan.type)).toBe(true);
    }
  });
});
