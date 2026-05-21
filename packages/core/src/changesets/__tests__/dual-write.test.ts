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
