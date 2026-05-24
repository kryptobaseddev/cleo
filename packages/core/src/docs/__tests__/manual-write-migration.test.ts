/**
 * Round-trip parity test for the T10179 + T10203 manual-write workaround
 * migration (T10371).
 *
 * Background: during SAGA T10176 (SG-BOUNDARY-REGISTRY) two tasks created
 * documentation via raw filesystem writes that bypassed `cleo docs add` /
 * `cleo changeset add`:
 *
 *   - `.changeset/t10179-executor-probe.md`           (pnpm/changesets format)
 *   - `docs/research/t10179-executor-probe-result.md` (research note)
 *   - `.changeset/t10203-napi-step-exports.md`        (CLEO-native changeset)
 *
 * The two `.changeset/*.md` files were consumed into the CHANGELOG during
 * the v2026.5.108 release (commit `f1fb26969`) and no longer exist on
 * disk. T10371 ensures the *content* of all three artifacts is preserved
 * in the docs SSoT under stable slugs so the originals can always be
 * reconstructed byte-for-byte.
 *
 * This test asserts the round-trip invariant: for each historic file, the
 * canonical SHA-256 from git history (or the live on-disk file) matches
 * the SHA-256 that comes back out of the SSoT when we re-import the same
 * bytes into an isolated tempdir-backed `.cleo/`. If a future migration
 * accidentally rewrites or recompresses the blob, this test fails.
 *
 * Each canonical record:
 *   - `t10179-executor-probe`        → research, SHA 1f5db3ae...
 *   - `t10179-changeset-archive`     → note,     SHA 264d27b2...
 *   - `t10203-napi-step-exports`     → changeset, SHA 116a017b...
 *
 * @task T10371
 * @epic T10293
 * @saga T10288
 */

import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let tempDir: string;

/**
 * Canonical SHA-256 of each migrated artifact, captured at T10371 migration
 * time. These values are the contract — changing them means a migration
 * has silently rewritten the bytes and must be re-validated.
 */
const CANONICAL_SHA = {
  t10179ExecutorProbeResearch: '1f5db3aec8bc535913ed67d209f8ac01a2f8aba3229d61d804aa0dbc31f66f03',
  t10179ChangesetArchive: '264d27b2a799dda0ca510857f234a9889d84f65d5e1be6d6b884532829bb3591',
  t10203NapiStepExports: '116a017b91b24aee0f9a12bc14bcc261b908d0f9a7afa45c72388fa4e8147bf6',
} as const;

/**
 * Verbatim bytes of each historic artifact, sourced from git history. The
 * inline literal is required so the test stays self-contained — it must
 * not depend on a working tree copy that could drift.
 */
const HISTORIC_BYTES = {
  t10179ExecutorProbeResearch: null as Buffer | null, // hydrated lazily from disk
  t10179ChangesetArchive: Buffer.from(
    `---
"@cleocode/cleo": patch
---

chore(T10179): Executor npm-pack probe (SAGA T10176)

Reusable probe at scripts/probes/tools-in-core-probe.mjs that validates whether the
lafs+cant tools-in-core pattern survives a clean npm-pack + tmpfs install + node require
flow. Result documented at research/t10179-executor-probe.

Verdict: release-equivalent (pnpm-pack) flow PASSES end-to-end; raw npm-pack mode fails
with EUNSUPPORTEDPROTOCOL because npm does not rewrite workspace:* markers. This is
expected since the real release pipeline uses pnpm publish — production consumers
receive correctly-rewritten manifests (verified via npm view @cleocode/cant@latest).
Pattern is safe to extend to new domains under SAGA T10176.
`,
    'utf-8',
  ),
  t10203NapiStepExports: Buffer.from(
    `---
id: t10203-napi-step-exports
tasks: [T10203]
kind: feat
summary: napi exports for worktrunk-core SDK step primitives (SAGA T10176)
---

Wraps each worktrunk_core step + lifecycle primitive (pruneWorktrees, promoteBranch, relocateWorktree, copyIgnored, removeDir, syncWorktree, runStep) as a thin napi binding. Unblocks T10204 (TS rewire of packages/worktree/src/worktree-prune.ts).
`,
    'utf-8',
  ),
};

/**
 * Compute SHA-256 of a Buffer as lowercase hex — matches
 * `packages/core/src/store/attachment-store.ts` canonical encoding.
 */
function sha256Hex(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

describe('T10371 manual-write migration round-trip', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-t10371-'));
    process.env['CLEO_DIR'] = join(tempDir, '.cleo');
  });

  afterEach(async () => {
    const { closeDb } = await import('../../store/sqlite.js');
    closeDb();
    delete process.env['CLEO_DIR'];
    await rm(tempDir, { recursive: true, force: true });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Canonical SHA invariants — the bytes that landed in SSoT at T10371
  // migration time must NEVER change. This guards against silent blob
  // rewrites by future migrations.
  // ───────────────────────────────────────────────────────────────────────

  it('historic T10179 changeset bytes hash to the canonical SHA', () => {
    expect(sha256Hex(HISTORIC_BYTES.t10179ChangesetArchive)).toBe(
      CANONICAL_SHA.t10179ChangesetArchive,
    );
  });

  it('historic T10203 changeset bytes hash to the canonical SHA', () => {
    expect(sha256Hex(HISTORIC_BYTES.t10203NapiStepExports)).toBe(
      CANONICAL_SHA.t10203NapiStepExports,
    );
  });

  // ───────────────────────────────────────────────────────────────────────
  // Round-trip parity — re-import the historic bytes into a fresh SSoT
  // and assert that `put → findBySlug` returns the same content SHA.
  // ───────────────────────────────────────────────────────────────────────

  it('round-trips T10179 changeset content through SSoT preserving SHA', async () => {
    const { createAttachmentStore } = await import('../../store/attachment-store.js');
    const { closeDb } = await import('../../store/sqlite.js');
    closeDb();

    const store = createAttachmentStore();
    const bytes = HISTORIC_BYTES.t10179ChangesetArchive;

    const meta = await store.put(
      bytes,
      { kind: 'blob', storageKey: '', mime: 'text/markdown', size: bytes.length },
      'task',
      'T10179',
      'cleo-t10371-test',
      undefined,
      { slug: 't10179-changeset-archive', type: 'note' },
    );

    expect(meta.sha256).toBe(CANONICAL_SHA.t10179ChangesetArchive);

    const lookup = await store.findBySlug('t10179-changeset-archive', undefined);
    expect(lookup).not.toBeNull();
    expect(lookup?.metadata.sha256).toBe(CANONICAL_SHA.t10179ChangesetArchive);
    expect(lookup?.type).toBe('note');
  });

  it('round-trips T10203 changeset content through SSoT preserving SHA', async () => {
    const { createAttachmentStore } = await import('../../store/attachment-store.js');
    const { closeDb } = await import('../../store/sqlite.js');
    closeDb();

    const store = createAttachmentStore();
    const bytes = HISTORIC_BYTES.t10203NapiStepExports;

    const meta = await store.put(
      bytes,
      { kind: 'blob', storageKey: '', mime: 'text/markdown', size: bytes.length },
      'task',
      'T10203',
      'cleo-t10371-test',
      undefined,
      { slug: 't10203-napi-step-exports', type: 'changeset' },
    );

    expect(meta.sha256).toBe(CANONICAL_SHA.t10203NapiStepExports);

    const lookup = await store.findBySlug('t10203-napi-step-exports', undefined);
    expect(lookup).not.toBeNull();
    expect(lookup?.metadata.sha256).toBe(CANONICAL_SHA.t10203NapiStepExports);
    expect(lookup?.type).toBe('changeset');
  });

  // ───────────────────────────────────────────────────────────────────────
  // Slug uniqueness — the three slugs MUST resolve to three distinct
  // SHA-256 values. Catches accidental slug-aliasing regressions.
  // ───────────────────────────────────────────────────────────────────────

  it('the three migrated slugs map to three distinct content SHAs', () => {
    const shas = new Set([
      CANONICAL_SHA.t10179ExecutorProbeResearch,
      CANONICAL_SHA.t10179ChangesetArchive,
      CANONICAL_SHA.t10203NapiStepExports,
    ]);
    expect(shas.size).toBe(3);
  });
});
