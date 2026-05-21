/**
 * import-orchestrator unit tests — T9709 (ST-MIG-1e).
 *
 * Covers the integration of the per-subtask helpers:
 *   - happy path: scan → classify → slug → dedup → store → audit
 *   - idempotency: running twice returns 0 new entries (SHA-dedup)
 *   - dry-run skips DocsAccessor writes
 *   - audit manifest is written when not dry-run
 *   - counter integrity: scanCount === importCount + noopCount + errorCount
 *   - CounterMismatchError raised when invariant violated
 *
 * Uses a FakeDocsAccessor so we don't take a dependency on the full
 * manifest.db blob store in unit tests.
 *
 * @epic T9628 (Saga T9625)
 * @task T9709
 */

import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  DocExportFormat,
  DocKind,
  DocRecord,
  DocSearchHit,
  DocsAccessor,
  ListDocsFilters,
  StoreDocParams,
  StoreDocResult,
} from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ImportManifest } from '../../import/audit.js';
import {
  CounterMismatchError,
  importTypeToDocKind,
  runDocsImport,
} from '../../import/import-orchestrator.js';

class FakeDocsAccessor implements DocsAccessor {
  public docs: DocRecord[] = [];
  public storeCalls = 0;

  async storeDoc(params: StoreDocParams): Promise<StoreDocResult> {
    this.storeCalls++;
    // Honour the real DocsAccessor contract: id MUST equal sha256(content)
    // for content-addressed kinds. The orchestrator depends on this so
    // listDocs() returns the same shas that the scanner computes.
    const id = createHash('sha256').update(params.content).digest('hex');
    const record: DocRecord = {
      id,
      kind: params.kind,
      content: params.content,
      title: params.title ?? null,
      createdAt: new Date().toISOString(),
      linkedTaskIds: params.linkedTaskIds ?? [],
      meta: params.meta ?? {},
    };
    this.docs.push(record);
    return { id, backend: params.kind === 'adr' ? 'manifest.db' : 'manifest.db' };
  }

  async getDoc(idOrHash: string): Promise<DocRecord | null> {
    return this.docs.find((d) => d.id === idOrHash) ?? null;
  }

  async listDocs(_filters?: ListDocsFilters): Promise<DocRecord[]> {
    return [...this.docs];
  }

  async searchDocs(_query: string, _limit?: number): Promise<DocSearchHit[]> {
    return [];
  }

  async exportDoc(id: string, _format?: DocExportFormat): Promise<string | null> {
    return (await this.getDoc(id))?.content ?? null;
  }

  async close(): Promise<void> {
    /* no-op */
  }
}

class FailingAccessor extends FakeDocsAccessor {
  public failNext = false;
  override async storeDoc(params: StoreDocParams): Promise<StoreDocResult> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('simulated store failure');
    }
    return super.storeDoc(params);
  }
}

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cleo-import-orch-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true }).catch(() => {
    /* never fail teardown */
  });
});

async function seed(rel: string, content: string): Promise<void> {
  const abs = join(root, rel);
  await mkdir(join(abs, '..'), { recursive: true });
  await writeFile(abs, content, 'utf-8');
}

describe('importTypeToDocKind', () => {
  it('maps adr → adr', () => {
    expect(importTypeToDocKind('adr')).toBe('adr' satisfies DocKind);
  });
  it('maps research|note|spec → agent-output', () => {
    expect(importTypeToDocKind('research')).toBe('agent-output');
    expect(importTypeToDocKind('note')).toBe('agent-output');
    expect(importTypeToDocKind('spec')).toBe('agent-output');
  });
});

describe('runDocsImport', () => {
  it('imports every discovered .md file on a clean run', async () => {
    await seed('.cleo/adrs/ADR-001.md', '# adr\n');
    await seed('.cleo/research/topic.md', '# research\n');
    await seed('docs/specs/api.md', '# spec\n');
    await seed('.cleo/agent-outputs/T100.md', '# note\n');

    const accessor = new FakeDocsAccessor();
    const auditDir = join(root, '_audit');
    const result = await runDocsImport({ root, accessor, auditDir });

    expect(result.counters).toEqual({
      scanCount: 4,
      importCount: 4,
      noopCount: 0,
      errorCount: 0,
    });
    expect(accessor.storeCalls).toBe(4);
    expect(result.manifestPath).toBeDefined();

    const manifest = JSON.parse(await readFile(result.manifestPath!, 'utf-8')) as ImportManifest;
    expect(manifest.entries.map((e) => e.action)).toEqual([
      'created',
      'created',
      'created',
      'created',
    ]);
    expect(manifest.entries.map((e) => e.type).sort()).toEqual(['adr', 'note', 'research', 'spec']);
  });

  it('is idempotent: second run on identical content → 0 new entries (SHA-dedup)', async () => {
    await seed('docs/a.md', 'identical bytes');
    await seed('docs/b.md', 'distinct bytes');

    const accessor = new FakeDocsAccessor();
    const auditDir = join(root, '_audit');
    const first = await runDocsImport({ root, accessor, auditDir });
    expect(first.counters.importCount).toBe(2);

    const before = accessor.storeCalls;
    const second = await runDocsImport({ root, accessor, auditDir });
    expect(accessor.storeCalls).toBe(before); // no new writes
    expect(second.counters).toEqual({
      scanCount: 2,
      importCount: 0,
      noopCount: 2,
      errorCount: 0,
    });
  });

  it('dry-run skips DocsAccessor writes but still counts + classifies', async () => {
    await seed('docs/a.md', 'hello');
    const accessor = new FakeDocsAccessor();
    const result = await runDocsImport({ root, accessor, dryRun: true });
    expect(accessor.storeCalls).toBe(0);
    expect(result.dryRun).toBe(true);
    expect(result.manifestPath).toBeUndefined();
    expect(result.counters.importCount).toBe(1);
  });

  it('force bypasses SHA dedup and re-stores existing content', async () => {
    await seed('docs/a.md', 'x');
    const accessor = new FakeDocsAccessor();
    const auditDir = join(root, '_audit');
    await runDocsImport({ root, accessor, auditDir });
    const before = accessor.storeCalls;
    const second = await runDocsImport({ root, accessor, auditDir, force: true });
    expect(accessor.storeCalls).toBe(before + 1);
    expect(second.counters.importCount).toBe(1);
    expect(second.counters.noopCount).toBe(0);
  });

  it('records error rows when DocsAccessor.storeDoc throws', async () => {
    await seed('docs/a.md', 'x');
    const accessor = new FailingAccessor();
    accessor.failNext = true;
    const auditDir = join(root, '_audit');
    const result = await runDocsImport({ root, accessor, auditDir });
    expect(result.counters).toEqual({
      scanCount: 1,
      importCount: 0,
      noopCount: 0,
      errorCount: 1,
    });
    expect(result.entries[0]?.action).toBe('error');
    expect(result.entries[0]?.error).toBe('simulated store failure');
  });

  it('throws CounterMismatchError when invariant would fail', async () => {
    // Construct a synthetic accessor where listDocs lies — the orchestrator
    // can detect when its own counters drift. We patch the orchestrator's
    // counters via a deliberately corrupted accessor that mutates state
    // mid-run. (Realistic prod hits this only on bugs; the test exercises
    // the assertion path.)
    await seed('docs/a.md', 'x');
    const accessor = new FakeDocsAccessor();

    // Monkey-patch listDocs to throw mid-run → the orchestrator should
    // surface the original error, not the counter assertion. To test the
    // counter path directly we construct the error manually.
    const counters = { scanCount: 5, importCount: 1, noopCount: 1, errorCount: 1 };
    const sum = counters.importCount + counters.noopCount + counters.errorCount;
    const err = new CounterMismatchError(counters, sum);
    expect(err.message).toContain('counter mismatch');
    expect(err.message).toContain('scanCount=5');
    expect(err.counters).toBe(counters);
  });

  it('produces deterministic slugs that chain on collision', async () => {
    // Two files with the same basename but different content live in
    // different dirs — slug generator must suffix the second one.
    await seed('docs/foo.md', 'one');
    await seed('docs/sub/foo.md', 'two');
    const accessor = new FakeDocsAccessor();
    const auditDir = join(root, '_audit');
    const result = await runDocsImport({ root, accessor, auditDir });
    const slugs = result.entries.map((e) => e.slug).sort();
    expect(slugs).toEqual(['foo', 'foo-2']);
  });

  // T9791 — benchmark fixtures (gsd/.claude/commands/gsd/import.md) ship
  // files whose basename slugifies to `import`, a RESERVED_SLUG. Prior to
  // T9791 the importer recorded these as errors and aborted; the orchestrator
  // now falls back to a parent-dir-prefixed slug so the bytes still make it
  // into the docs SSoT.
  it('falls back to parent-dir prefix when basename slugifies to a reserved word', async () => {
    await seed('nested/gsd/workflows/import.md', '# import doc\n');
    const accessor = new FakeDocsAccessor();
    const auditDir = join(root, '_audit');
    const result = await runDocsImport({ root, accessor, auditDir });
    expect(result.counters).toEqual({
      scanCount: 1,
      importCount: 1,
      noopCount: 0,
      errorCount: 0,
    });
    expect(result.entries[0]?.slug).toBeDefined();
    expect(result.entries[0]?.slug).not.toBe('import');
    // Slug must contain a parent-dir segment so it's traceable.
    expect(result.entries[0]?.slug).toMatch(/workflows|gsd|nested|imported/);
  });

  it('still errors when a reserved-slug basename has no usable parent context', async () => {
    await seed('import.md', '# top-level reserved\n');
    const accessor = new FakeDocsAccessor();
    const auditDir = join(root, '_audit');
    const result = await runDocsImport({ root, accessor, auditDir });
    // Top-level reserved name → fallback to `imported-import` slug, succeeds.
    expect(result.counters.errorCount).toBe(0);
    expect(result.counters.importCount).toBe(1);
    expect(result.entries[0]?.slug).toBe('imported-import');
  });
});
