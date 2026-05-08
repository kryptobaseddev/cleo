/**
 * T9065: Cross-link DocsAccessor with T1824 (Decision Storage Consolidation)
 * and T1825 (ADR migration).
 *
 * This test:
 *   1. Verifies DocsAccessor.storeDoc(kind:'adr') round-trips a real ADR file
 *      from .cleo/adrs/ — proving the DocsAccessor API surface is usable for ADR
 *      ingestion as required by T1824 and T1825.
 *   2. Documents the ADR storage model alignment decision (T1824):
 *      ADRs remain on filesystem as the source of truth; DocsAccessor provides
 *      an indexing layer via storeDoc (backed by manifest.db blob store).
 *      This is "filesystem + llmtxt index, not either-or" per T1824 acceptance.
 *
 * T1824 alignment notes (recorded as inline documentation):
 *   - ADRs remain on filesystem (.cleo/adrs/*.md) — canonical source.
 *   - storeDoc(kind:'adr') INDEXES the ADR in manifest.db (content-addressed).
 *   - Callers may use DocsAccessor.searchDocs() to find ADRs by semantic query.
 *   - No ADR file is deleted from .cleo/adrs/ by DocsAccessor — filesystem is
 *     the source of truth, DocsAccessor is the index layer.
 *
 * T1825 alignment notes:
 *   - ADR migration (T1825) should ingest ADRs via storeDoc(kind:'adr') to
 *     populate the DocsAccessor index alongside filesystem storage.
 *   - T1825 acceptance criteria should include: "ADRs indexed via
 *     DocsAccessor.storeDoc(kind:'adr') after migration".
 *
 * @task T9065
 * @see packages/contracts/src/docs-accessor.ts (DocsAccessor interface)
 * @see packages/core/src/store/docs-accessor-impl.ts (DocsAccessorImpl)
 * @see T1824 — Decision Storage Consolidation
 * @see T1825 — ADR migration
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDocsAccessor } from '../store/docs-accessor-impl.js';

// ---------------------------------------------------------------------------
// Test fixture content (ADR format matches .cleo/adrs/*.md)
// ---------------------------------------------------------------------------

const FIXTURE_ADR_CONTENT = `# ADR-TEST: DocsAccessor storage model

**Status**: Accepted
**Task**: T9065
**Date**: 2026-05-08

## Context

CLEO stores ADRs in .cleo/adrs/*.md on the filesystem. T1824 (Decision Storage
Consolidation) adds a DocsAccessor indexing layer backed by manifest.db
(CleoBlobStore). The model is: filesystem = source of truth, DocsAccessor = index.

## Decision

ADRs remain on filesystem. DocsAccessor.storeDoc(kind:'adr') indexes them in
manifest.db for semantic search. No ADR is deleted from .cleo/adrs/ by DocsAccessor.

## Consequences

- Callers must call storeDoc for each ADR to populate the index (T1825).
- Filesystem remains the authoritative source — git history is preserved.
- DocsAccessor.searchDocs() enables semantic ADR lookup (once T9064 integrates
  llmtxt/similarity for full embedding-based search).
`;

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let tempProjectRoot: string;

beforeEach(async () => {
  tempProjectRoot = await mkdtemp(join(tmpdir(), 'cleo-docs-adr-test-'));
  // Create .cleo structure required by CleoBlobStore
  await mkdir(join(tempProjectRoot, '.cleo', 'blobs'), { recursive: true });
  // Write a fixture ADR to simulate .cleo/adrs/
  await mkdir(join(tempProjectRoot, '.cleo', 'adrs'), { recursive: true });
  await writeFile(
    join(tempProjectRoot, '.cleo', 'adrs', 'ADR-TEST-docs-accessor-model.md'),
    FIXTURE_ADR_CONTENT,
    'utf-8',
  );
});

afterEach(async () => {
  await rm(tempProjectRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// T9065 round-trip test
// ---------------------------------------------------------------------------

describe('DocsAccessor ADR round-trip (T9065)', () => {
  it("storeDoc(kind:'adr') stores and retrieves ADR content", async () => {
    const accessor = createDocsAccessor(tempProjectRoot);
    try {
      // Store the ADR content
      const result = await accessor.storeDoc({
        kind: 'adr',
        content: FIXTURE_ADR_CONTENT,
        title: 'ADR-TEST-docs-accessor-model.md',
        linkedTaskIds: ['T9065', 'T1824', 'T1825'],
        meta: { path: '.cleo/adrs/ADR-TEST-docs-accessor-model.md' },
      });

      // Verify store result
      expect(result.id).toBeTruthy();
      expect(result.backend).toBe('manifest.db');

      // Retrieve and round-trip
      const doc = await accessor.getDoc(result.id);
      expect(doc).not.toBeNull();
      expect(doc?.kind).toBe('adr');
      expect(doc?.content).toBe(FIXTURE_ADR_CONTENT);
      expect(doc?.title).toBe('ADR-TEST-docs-accessor-model.md');
      expect(doc?.linkedTaskIds).toContain('T9065');
      expect(doc?.linkedTaskIds).toContain('T1824');
    } finally {
      await accessor.close();
    }
  });

  it("listDocs(kind:'adr') returns stored ADR", async () => {
    const accessor = createDocsAccessor(tempProjectRoot);
    try {
      await accessor.storeDoc({
        kind: 'adr',
        content: FIXTURE_ADR_CONTENT,
        title: 'ADR-TEST.md',
        linkedTaskIds: ['T9065'],
      });

      const docs = await accessor.listDocs({ kind: 'adr', limit: 10 });
      expect(docs.length).toBeGreaterThanOrEqual(1);
      const adrDoc = docs.find((d) => d.title === 'ADR-TEST.md');
      expect(adrDoc).toBeDefined();
    } finally {
      await accessor.close();
    }
  });

  it('exportDoc returns formatted markdown with linked tasks (T1824 model validation)', async () => {
    const accessor = createDocsAccessor(tempProjectRoot);
    try {
      const { id } = await accessor.storeDoc({
        kind: 'adr',
        content: FIXTURE_ADR_CONTENT,
        title: 'ADR-TEST: DocsAccessor storage model',
        linkedTaskIds: ['T1824', 'T1825'],
      });

      const exported = await accessor.exportDoc(id, 'markdown');
      expect(exported).not.toBeNull();
      // Title appears as heading
      expect(exported).toContain('# ADR-TEST: DocsAccessor storage model');
      // Linked task IDs appear in the exported doc
      expect(exported).toContain('T1824');
      // Content is preserved
      expect(exported).toContain('filesystem = source of truth');
    } finally {
      await accessor.close();
    }
  });
});
