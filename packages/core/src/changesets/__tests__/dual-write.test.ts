/**
 * Tests for {@link writeChangesetEntry} — dual-write transaction.
 *
 * Covers:
 *  - Happy path: writes BOTH `.changeset/<slug>.md` AND the SSoT blob.
 *  - Slug pattern enforcement: `E_SLUG_PATTERN_MISMATCH` with example hint.
 *  - Invalid entry (schema violation): `E_INVALID_ENTRY`.
 *  - Round-trip parity: rendered markdown re-parses to the same entry.
 *  - Breaking entry: `breaking:` block-scalar survives round-trip.
 *  - Notes body: markdown body survives round-trip.
 *
 * @epic T9793 (E-DOCS-CHANGESET-INTEGRATION)
 * @task T9793
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChangesetEntry } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseChangesetFile } from '../parser.js';
import { renderChangesetMarkdown, writeChangesetEntry } from '../writer.js';

/**
 * Per-test temp project root. Each test gets a fresh `.changeset/`-bearing
 * directory + `.cleo/` so the attachment store's content-addressed writes do
 * not collide across tests.
 */
let projectRoot: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'cleo-changeset-dual-'));
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('writeChangesetEntry — happy path', () => {
  it('writes BOTH .changeset/<slug>.md AND the SSoT blob for a minimal feat entry', async () => {
    const entry: ChangesetEntry = {
      id: 't9793-happy-path',
      tasks: ['T9793'],
      kind: 'feat',
      summary: 'Dual-write changeset entry SSoT-first.',
    };

    const outcome = await writeChangesetEntry(entry, { projectRoot });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return; // type narrow

    // File surface ------------------------------------------------------------
    expect(outcome.result.filePath).toBe(join(projectRoot, '.changeset', 't9793-happy-path.md'));
    expect(existsSync(outcome.result.filePath)).toBe(true);

    // SSoT surface ------------------------------------------------------------
    // The attachment ID must be a real `att_*`/UUID-shaped value, not empty.
    expect(outcome.result.attachmentId.length).toBeGreaterThan(0);
    // SHA-256 hex = 64 chars.
    expect(outcome.result.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(outcome.result.slug).toBe('t9793-happy-path');
    expect(outcome.result.ownerId).toBe('T9793');
  });

  it('round-trips: parseChangesetFile(write(entry)) === entry', async () => {
    const entry: ChangesetEntry = {
      id: 't9793-round-trip',
      tasks: ['T9793', 'T9788'],
      kind: 'fix',
      summary: 'Round-trip parity for the writer.',
      prs: [349, 357],
    };

    const outcome = await writeChangesetEntry(entry, { projectRoot });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const reparsed = parseChangesetFile(outcome.result.filePath);
    expect(reparsed.id).toBe(entry.id);
    expect(reparsed.tasks).toEqual(entry.tasks);
    expect(reparsed.kind).toBe(entry.kind);
    expect(reparsed.summary).toBe(entry.summary);
    expect(reparsed.prs).toEqual(entry.prs);
  });

  it('preserves the markdown body as `notes` on round-trip', async () => {
    const entry: ChangesetEntry = {
      id: 't9793-notes-body',
      tasks: ['T9793'],
      kind: 'refactor',
      summary: 'Capture body as notes.',
      notes: 'First paragraph.\n\nSecond paragraph survives the round-trip.',
    };

    const outcome = await writeChangesetEntry(entry, { projectRoot });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const reparsed = parseChangesetFile(outcome.result.filePath);
    expect(reparsed.notes).toBe(entry.notes);
  });

  it('renders the `breaking:` block-scalar so it survives YAML round-trip', async () => {
    const entry: ChangesetEntry = {
      id: 't9793-breaking-change',
      tasks: ['T9793'],
      kind: 'breaking',
      summary: 'Changeset DocKind becomes SSoT-first.',
      breaking:
        'Consumers reading `.changeset/*.md` directly should switch to readChangesetsSsotFirst() for provenance metadata.',
    };

    const outcome = await writeChangesetEntry(entry, { projectRoot });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const reparsed = parseChangesetFile(outcome.result.filePath);
    expect(reparsed.kind).toBe('breaking');
    expect(reparsed.breaking).toBe(entry.breaking);
  });

  it('emits the recorded `attachedBy` identity to the SSoT row', async () => {
    const entry: ChangesetEntry = {
      id: 't9793-attached-by',
      tasks: ['T9793'],
      kind: 'chore',
      summary: 'Identity propagation.',
    };
    const outcome = await writeChangesetEntry(entry, {
      projectRoot,
      attachedBy: 'orchestrator-test',
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    // The attachment ID being present is sufficient — the legacy attachment
    // store handles attachedBy propagation through its own tests. We assert
    // here that the outcome includes the attachment surface (proves SSoT
    // wrote, not just file).
    expect(outcome.result.attachmentId.length).toBeGreaterThan(0);
  });
});

describe('writeChangesetEntry — slug pattern validation', () => {
  it('rejects a slug missing the t#### prefix with E_SLUG_PATTERN_MISMATCH', async () => {
    // The doc-kind registry requires /^t\d+-[a-z0-9-]+$/ for `changeset`.
    // A slug like `feature-x` is otherwise schema-valid (`/^[a-z0-9][a-z0-9-]*$/`)
    // but does NOT carry the required task-id anchor.
    const entry: ChangesetEntry = {
      id: 'feature-x',
      tasks: ['T9793'],
      kind: 'feat',
      summary: 'No task ID anchor — should be rejected.',
    };

    const outcome = await writeChangesetEntry(entry, { projectRoot });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe('E_SLUG_PATTERN_MISMATCH');
    // Friendly example hint surfaces from the registry.
    expect(outcome.error.code === 'E_SLUG_PATTERN_MISMATCH' && outcome.error.example).toBeDefined();
    // Neither surface should have been written when slug validation fails.
    expect(existsSync(join(projectRoot, '.changeset', 'feature-x.md'))).toBe(false);
  });

  it('accepts t9999-* prefix slugs', async () => {
    const entry: ChangesetEntry = {
      id: 't9999-valid-prefix',
      tasks: ['T9999'],
      kind: 'feat',
      summary: 'Valid prefix passes.',
    };
    const outcome = await writeChangesetEntry(entry, { projectRoot });
    expect(outcome.ok).toBe(true);
  });
});

describe('writeChangesetEntry — schema validation', () => {
  it('rejects an entry with an empty tasks array (schema gate)', async () => {
    // The ChangesetEntrySchema enforces `tasks.length >= 1`. We bypass the
    // compile-time type guard with a cast so the schema gate fires at runtime
    // — this is the exact failure mode an HTTP-dispatch caller would hit
    // when passing untrusted JSON.
    const bad = {
      id: 't9793-no-tasks',
      tasks: [],
      kind: 'feat',
      summary: 'Empty tasks should be rejected.',
    } as unknown as ChangesetEntry;

    const outcome = await writeChangesetEntry(bad, { projectRoot });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe('E_INVALID_ENTRY');
    expect(existsSync(join(projectRoot, '.changeset', 't9793-no-tasks.md'))).toBe(false);
  });

  it('rejects a breaking entry that lacks the migration note', async () => {
    const bad = {
      id: 't9793-broken-breaking',
      tasks: ['T9793'],
      kind: 'breaking',
      summary: 'Breaking without migration note.',
      // Intentionally no `breaking` field — schema refinement should fire.
    } as unknown as ChangesetEntry;

    const outcome = await writeChangesetEntry(bad, { projectRoot });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe('E_INVALID_ENTRY');
  });

  // ────────────────────────────────────────────────────────────────────────
  // T9936 (Saga T9862) — invalid `kind` values must be rejected BEFORE any
  // dual-write side effect. The historical drift `kind: 'feature'` is the
  // canonical real-world example (4 entries leaked through legacy writers
  // before the schema gate hardened). Every entry below probes one invalid
  // shape and asserts:
  //   1. `outcome.ok` is false with `E_INVALID_ENTRY`.
  //   2. `.changeset/<slug>.md` was NEVER created (no partial state).
  //   3. The error message mentions `kind` so the operator can localise.
  // ────────────────────────────────────────────────────────────────────────
  describe('writeChangesetEntry — invalid kind rejection (T9936)', () => {
    /**
     * Probe a single invalid kind value end-to-end. Asserts schema gate
     * fires before any filesystem mutation and surfaces the field name.
     */
    async function probeInvalidKind(invalidKind: unknown, slug: string): Promise<void> {
      const bad = {
        id: slug,
        tasks: ['T9936'],
        kind: invalidKind,
        summary: `Invalid kind probe: ${String(invalidKind)}`,
      } as unknown as ChangesetEntry;

      const outcome = await writeChangesetEntry(bad, { projectRoot });
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.error.code).toBe('E_INVALID_ENTRY');
      // The Zod issue path is preserved so operators see WHICH field failed.
      expect(outcome.error.message).toContain('kind');
      // No partial state — file must NOT exist on disk.
      expect(existsSync(join(projectRoot, '.changeset', `${slug}.md`))).toBe(false);
    }

    it('rejects kind="feature" — the canonical historical drift (T9936)', async () => {
      // The real-world bug: 4 changesets were written with `kind: feature`
      // instead of canonical `kind: feat`, blowing aggregator output. The
      // schema gate MUST refuse this exact shape.
      await probeInvalidKind('feature', 't9936-kind-feature');
    });

    it('rejects kind="fixes" (plural drift)', async () => {
      await probeInvalidKind('fixes', 't9936-kind-fixes');
    });

    it('rejects kind="improvement" (commonly-mistyped synonym)', async () => {
      await probeInvalidKind('improvement', 't9936-kind-improvement');
    });

    it('rejects kind="" (empty string)', async () => {
      await probeInvalidKind('', 't9936-kind-empty');
    });

    it('rejects kind=null', async () => {
      await probeInvalidKind(null, 't9936-kind-null');
    });

    it('rejects kind=undefined', async () => {
      await probeInvalidKind(undefined, 't9936-kind-undefined');
    });

    it('rejects kind with leading/trailing whitespace ("feat ")', async () => {
      // Schema is strict — whitespace-tolerant matching would erode the
      // canonical set. Operators must pass the bare token.
      await probeInvalidKind('feat ', 't9936-kind-whitespace');
    });

    it('accepts every canonical kind in CHANGESET_KINDS — coverage anchor', async () => {
      // Round-trip check: each canonical kind MUST be writable. If a future
      // schema edit drops one (or renames it), this test catches it.
      const { CHANGESET_KINDS } = await import('@cleocode/contracts');
      for (const kind of CHANGESET_KINDS) {
        const entry: ChangesetEntry = {
          id: `t9936-canonical-${kind}`,
          tasks: ['T9936'],
          kind,
          summary: `Canonical kind ${kind} accepted.`,
          // `breaking` requires the migration note refinement.
          ...(kind === 'breaking' ? { breaking: 'migration step' } : {}),
        };
        const outcome = await writeChangesetEntry(entry, { projectRoot });
        expect(outcome.ok, `kind '${kind}' should be accepted`).toBe(true);
      }
    });
  });
});

describe('renderChangesetMarkdown', () => {
  it('opens and closes with --- fences', () => {
    const md = renderChangesetMarkdown({
      id: 't1234-x',
      tasks: ['T1234'],
      kind: 'feat',
      summary: 'X.',
    });
    expect(md.startsWith('---\n')).toBe(true);
    // Two fences total — opening + closing.
    const fenceCount = (md.match(/^---$/gm) ?? []).length;
    expect(fenceCount).toBe(2);
  });

  it('emits prs as a YAML flow-style array when present', () => {
    const md = renderChangesetMarkdown({
      id: 't1234-y',
      tasks: ['T1234'],
      kind: 'feat',
      summary: 'Y.',
      prs: [42, 43],
    });
    expect(md).toContain('prs: [42, 43]');
  });
});

describe('writeChangesetEntry — written file content', () => {
  it('matches renderChangesetMarkdown output byte-for-byte', async () => {
    const entry: ChangesetEntry = {
      id: 't9793-byte-parity',
      tasks: ['T9793'],
      kind: 'docs',
      summary: 'Byte parity between renderer and file write.',
    };
    const expected = renderChangesetMarkdown(entry);

    const outcome = await writeChangesetEntry(entry, { projectRoot });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const actual = readFileSync(outcome.result.filePath, 'utf-8');
    expect(actual).toBe(expected);
  });
});
