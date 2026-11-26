/**
 * `cleo docs modernize` tree apply on a case-insensitive filesystem (T14610):
 * a case-only rename keeps the file, and a moved published mirror takes its
 * `docs_publications` row with it.
 *
 * T14631: a merged or deleted mirror's row is removed, a row already at the
 * new path is kept, rollback restores every row exactly (`publishedAt`
 * included), and a symlink or hard link to a kept file is still removed.
 *
 * Case-insensitive lookup is simulated on any host: under the docs root,
 * every path given to a path-taking `node:fs` function the apply, guard,
 * blob-keep and status code imports resolves to the existing entry whose name
 * matches ignoring case, as APFS and NTFS resolve it. A rename onto such a
 * name therefore lands in the old entry, which keeps its old spelling.
 *
 * @task T14610
 */

import { createHash } from 'node:crypto';
import type * as Fs from 'node:fs';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import type * as FsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb } from '../../../store/sqlite.js';
import type { DocsPublicationRecord } from '../../docs-ops.js';
import { statusDocs } from '../../docs-ops.js';
import {
  insertDocsPublication,
  readDocsPublications,
  upsertDocsPublication,
} from '../../publications-store.js';
import { applyDocsModernize, rollbackDocsModernize } from '../apply.js';
import { planDocsModernize } from '../plan.js';

const fold = vi.hoisted(() => ({ root: null as string | null }));

/** Resolve `p` the way a case-insensitive filesystem would, under `fold.root`. */
function caseFold(real: typeof Fs, p: unknown): unknown {
  const root = fold.root;
  if (typeof p !== 'string' || root === null || !p.startsWith(root + sep)) return p;
  let current = root;
  for (const part of p.slice(root.length + 1).split(sep)) {
    let entries: string[] = [];
    try {
      entries = real.readdirSync(current);
    } catch {
      entries = [];
    }
    const hit = entries.includes(part)
      ? part
      : entries.find((e) => e.toLowerCase() === part.toLowerCase());
    current = join(current, hit ?? part);
  }
  return current;
}

vi.mock('node:fs', async () => {
  const real = await vi.importActual<typeof Fs>('node:fs');
  const f = (p: unknown) => caseFold(real, p) as string;
  return {
    ...real,
    existsSync: (p: Fs.PathLike) => real.existsSync(f(p)),
    statSync: (p: Fs.PathLike, o?: Fs.StatSyncOptions) => real.statSync(f(p), o),
    lstatSync: (p: Fs.PathLike, o?: Fs.StatSyncOptions) => real.lstatSync(f(p), o),
    openSync: (p: Fs.PathLike, flags?: Fs.OpenMode) => real.openSync(f(p), flags),
    copyFileSync: (a: Fs.PathLike, b: Fs.PathLike) => real.copyFileSync(f(a), f(b)),
    linkSync: (a: Fs.PathLike, b: Fs.PathLike) => real.linkSync(f(a), f(b)),
    readFileSync: (p: Fs.PathOrFileDescriptor, o?: never) => real.readFileSync(f(p), o),
    writeFileSync: (p: Fs.PathOrFileDescriptor, d: string, o?: Fs.WriteFileOptions) =>
      real.writeFileSync(f(p), d, o),
    rmSync: (p: Fs.PathLike, o?: Fs.RmOptions) => real.rmSync(f(p), o),
    unlinkSync: (p: Fs.PathLike) => real.unlinkSync(f(p)),
    renameSync: (a: Fs.PathLike, b: Fs.PathLike) => real.renameSync(f(a), f(b)),
    realpathSync: Object.assign((p: Fs.PathLike) => real.realpathSync(f(p)), {
      native: (p: Fs.PathLike) => real.realpathSync.native(f(p)),
    }),
  };
});

vi.mock('node:fs/promises', async () => {
  const realFs = await vi.importActual<typeof Fs>('node:fs');
  const real = await vi.importActual<typeof FsPromises>('node:fs/promises');
  const f = (p: unknown) => caseFold(realFs, p) as string;
  return {
    ...real,
    stat: (p: Fs.PathLike) => real.stat(f(p)),
    lstat: (p: Fs.PathLike) => real.lstat(f(p)),
    realpath: (p: Fs.PathLike) => real.realpath(f(p)),
    open: (p: Fs.PathLike, flags?: Fs.OpenMode) => real.open(f(p), flags),
    unlink: (p: Fs.PathLike) => real.unlink(f(p)),
    readFile: (p: Fs.PathLike, o?: never) => real.readFile(f(p), o),
    writeFile: (p: Fs.PathLike, d: string | Uint8Array) => real.writeFile(f(p), d),
    rename: (a: Fs.PathLike, b: Fs.PathLike) => real.rename(f(a), f(b)),
    rm: (p: Fs.PathLike, o?: Fs.RmOptions) => real.rm(f(p), o),
  };
});

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

/** The ledger in a stable order, for exact comparison. */
async function ledgerRows(projectRoot: string): Promise<DocsPublicationRecord[]> {
  const rows = await readDocsPublications(projectRoot);
  return rows.sort((a, b) => a.publishedPath.localeCompare(b.publishedPath));
}

describe('modernize tree apply: case-only renames (T14610)', () => {
  let projectRoot: string;
  let docsRoot: string;
  let prevCleoDir: string | undefined;
  let prevCwd: string;
  const text = '# ADR 001 store\n\n## Context\nc\n\n## Decision\nd\n';

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'cleo-modernize-case-'));
    mkdirSync(join(projectRoot, '.cleo'), { recursive: true });
    mkdirSync(join(projectRoot, '.git'), { recursive: true });
    prevCleoDir = process.env['CLEO_DIR'];
    process.env['CLEO_DIR'] = join(projectRoot, '.cleo');
    prevCwd = process.cwd();
    process.chdir(projectRoot);
    docsRoot = join(projectRoot, 'docs');
    mkdirSync(join(docsRoot, 'adr'), { recursive: true });
    writeFileSync(join(docsRoot, 'adr', 'ADR-001-store.md'), text);
  });

  afterEach(() => {
    fold.root = null;
    closeDb();
    process.chdir(prevCwd);
    if (prevCleoDir === undefined) delete process.env['CLEO_DIR'];
    else process.env['CLEO_DIR'] = prevCleoDir;
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('keeps the bytes under the new name and moves the publication row; rollback reverses both', async () => {
    const plan = await planDocsModernize({
      root: docsRoot,
      projectRoot,
      decide: { connection: null },
    });
    const row = plan.rows.find((r) => r.path === 'adr/ADR-001-store.md');
    expect(row?.target).toBe('adr/adr-001-store.md');
    await upsertDocsPublication(projectRoot, {
      ownerId: 'T1',
      blobName: 'adr-001-store.md',
      publishedPath: 'docs/adr/ADR-001-store.md',
      lastBlobSha: sha(text),
    });

    fold.root = docsRoot;
    const receipt = await applyDocsModernize({ plan, projectRoot, allowDirty: true });

    // AC1: the file sits at the new name with the same bytes.
    expect(readdirSync(join(docsRoot, 'adr'))).toEqual(['adr-001-store.md']);
    expect(readFileSync(join(docsRoot, 'adr', 'adr-001-store.md'), 'utf-8')).toBe(text);
    expect(receipt.moves).toEqual([{ from: 'adr/ADR-001-store.md', to: 'adr/adr-001-store.md' }]);

    // AC2: the ledger row moved with it, and status reads the new path in sync.
    const ledger = await readDocsPublications(projectRoot);
    expect(ledger.map((p) => p.publishedPath)).toEqual(['docs/adr/adr-001-store.md']);
    const status = await statusDocs({ projectRoot });
    expect(status.items).toEqual([
      expect.objectContaining({ publishedPath: 'docs/adr/adr-001-store.md', drift: 'in-sync' }),
    ]);

    await rollbackDocsModernize(projectRoot, receipt.runId);
    expect(readdirSync(join(docsRoot, 'adr'))).toEqual(['ADR-001-store.md']);
    expect(readFileSync(join(docsRoot, 'adr', 'ADR-001-store.md'), 'utf-8')).toBe(text);
    const restored = await readDocsPublications(projectRoot);
    expect(restored.map((p) => p.publishedPath)).toEqual(['docs/adr/ADR-001-store.md']);
  });

  it('keeps a row already at the new path, and rollback restores both rows exactly (T14631)', async () => {
    const plan = await planDocsModernize({
      root: docsRoot,
      projectRoot,
      decide: { connection: null },
    });
    const moving: DocsPublicationRecord = {
      ownerId: 'T1',
      blobName: 'adr-001-store.md',
      publishedPath: 'docs/adr/ADR-001-store.md',
      lastBlobSha: sha(text),
      publishedAt: '2026-01-01T00:00:00.000Z',
    };
    const existing: DocsPublicationRecord = {
      ownerId: 'T1',
      blobName: 'adr-001-store.md',
      publishedPath: 'docs/adr/adr-001-store.md',
      lastBlobSha: sha('an older publication'),
      publishedAt: '2025-06-01T00:00:00.000Z',
    };
    await insertDocsPublication(projectRoot, moving);
    await insertDocsPublication(projectRoot, existing);
    const before = await ledgerRows(projectRoot);

    fold.root = docsRoot;
    const receipt = await applyDocsModernize({ plan, projectRoot, allowDirty: true });

    // The row already at the new path is untouched; the moved row is dropped.
    expect(await ledgerRows(projectRoot)).toEqual([existing]);
    const step = receipt.ops.find((o) => o.op === 'move-publication');
    expect(step?.prior?.publication).toMatchObject({
      targetExisted: true,
      publishedAt: moving.publishedAt,
    });

    await rollbackDocsModernize(projectRoot, receipt.runId);
    expect(await ledgerRows(projectRoot)).toEqual(before);
  });

  it('carries publishedAt through a move and back (T14631)', async () => {
    const plan = await planDocsModernize({
      root: docsRoot,
      projectRoot,
      decide: { connection: null },
    });
    const row: DocsPublicationRecord = {
      ownerId: 'T1',
      blobName: 'adr-001-store.md',
      publishedPath: 'docs/adr/ADR-001-store.md',
      lastBlobSha: sha(text),
      publishedAt: '2026-01-01T00:00:00.000Z',
    };
    await insertDocsPublication(projectRoot, row);

    fold.root = docsRoot;
    const receipt = await applyDocsModernize({ plan, projectRoot, allowDirty: true });
    expect(await ledgerRows(projectRoot)).toEqual([
      { ...row, publishedPath: 'docs/adr/adr-001-store.md' },
    ]);

    await rollbackDocsModernize(projectRoot, receipt.runId);
    expect(await ledgerRows(projectRoot)).toEqual([row]);
  });
});

describe('modernize tree apply: merged, deleted and linked mirrors (T14631)', () => {
  let projectRoot: string;
  let docsRoot: string;
  let prevCleoDir: string | undefined;
  let prevCwd: string;
  const keep = '# ADR 001 store\n\n## Context\nc\n\n## Decision\nd\n';
  const merged = '# Store notes\n\nMore store context.\n';
  const deleted = '# Scratch\n\nScratch notes.\n';

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'cleo-modernize-pubs-'));
    mkdirSync(join(projectRoot, '.cleo'), { recursive: true });
    mkdirSync(join(projectRoot, '.git'), { recursive: true });
    prevCleoDir = process.env['CLEO_DIR'];
    process.env['CLEO_DIR'] = join(projectRoot, '.cleo');
    prevCwd = process.cwd();
    process.chdir(projectRoot);
    docsRoot = join(projectRoot, 'docs');
    mkdirSync(join(docsRoot, 'adr'), { recursive: true });
    // Already canonical, so it is kept in place on every filesystem.
    writeFileSync(join(docsRoot, 'adr', 'adr-001-store.md'), keep);
  });

  afterEach(() => {
    closeDb();
    process.chdir(prevCwd);
    if (prevCleoDir === undefined) delete process.env['CLEO_DIR'];
    else process.env['CLEO_DIR'] = prevCleoDir;
    rmSync(projectRoot, { recursive: true, force: true });
  });

  /** The survivor's slug, from a plan with no overrides. */
  async function survivorSlug(): Promise<string> {
    const plan = await planDocsModernize({
      root: docsRoot,
      projectRoot,
      decide: { connection: null },
    });
    const row = plan.rows.find((r) => r.path === 'adr/adr-001-store.md');
    expect(row?.disposition).toBe('keep');
    return row?.slug ?? '';
  }

  it('removes the rows of merged and deleted mirrors; rollback restores them exactly', async () => {
    writeFileSync(join(docsRoot, 'adr', 'store-notes.md'), merged);
    writeFileSync(join(docsRoot, 'adr', 'scratch.md'), deleted);
    const slug = await survivorSlug();
    const plan = await planDocsModernize({
      root: docsRoot,
      projectRoot,
      decide: { connection: null },
      overrides: {
        'adr/store-notes.md': { disposition: 'merge-into', target: slug, reason: 'test: merge' },
        'adr/scratch.md': { disposition: 'delete', reason: 'test: delete' },
      },
    });
    const rows: DocsPublicationRecord[] = [
      {
        ownerId: 'T1',
        blobName: 'scratch.md',
        publishedPath: 'docs/adr/scratch.md',
        lastBlobSha: sha(deleted),
        publishedAt: '2026-02-01T00:00:00.000Z',
      },
      {
        ownerId: 'T1',
        blobName: 'store-notes.md',
        publishedPath: 'docs/adr/store-notes.md',
        lastBlobSha: sha(merged),
        publishedAt: '2026-03-01T00:00:00.000Z',
      },
    ];
    for (const row of rows) await insertDocsPublication(projectRoot, row);

    const receipt = await applyDocsModernize({ plan, projectRoot, allowDirty: true });
    expect(existsSync(join(docsRoot, 'adr', 'store-notes.md'))).toBe(false);
    expect(existsSync(join(docsRoot, 'adr', 'scratch.md'))).toBe(false);
    // AC1: no ledger row, and so no status item, names a removed path.
    expect(await ledgerRows(projectRoot)).toEqual([]);
    const status = await statusDocs({ projectRoot });
    expect(status.items).toEqual([]);
    const steps = receipt.ops
      .filter((o) => o.op === 'move-publication')
      .map((o) => [o.path, o.target, o.prior?.publication?.toPath])
      .sort();
    expect(steps).toEqual([
      ['adr/scratch.md', null, null],
      ['adr/store-notes.md', null, null],
    ]);

    await rollbackDocsModernize(projectRoot, receipt.runId);
    expect(await ledgerRows(projectRoot)).toEqual(rows);
  });

  it('removes a non-survivor hard link to a kept file', async () => {
    const keptAbs = join(docsRoot, 'adr', 'adr-001-store.md');
    linkSync(keptAbs, join(docsRoot, 'adr', 'store-copy.md'));
    const slug = await survivorSlug();
    const plan = await planDocsModernize({
      root: docsRoot,
      projectRoot,
      decide: { connection: null },
      overrides: {
        'adr/store-copy.md': { disposition: 'merge-into', target: slug, reason: 'test: link' },
      },
    });
    expect(plan.rows.find((r) => r.path === 'adr/store-copy.md')?.disposition).toBe('merge-into');

    const receipt = await applyDocsModernize({ plan, projectRoot, allowDirty: true });
    expect(readdirSync(join(docsRoot, 'adr'))).toEqual(['adr-001-store.md']);
    expect(readFileSync(keptAbs, 'utf-8')).toBe(keep);
    expect(receipt.deleted).toEqual(['adr/store-copy.md']);
  });

  it('never treats a symlink as the kept file it points at: apply refuses it before any write', async () => {
    const keptAbs = join(docsRoot, 'adr', 'adr-001-store.md');
    writeFileSync(join(docsRoot, 'adr', 'store-copy.md'), keep);
    const slug = await survivorSlug();
    const plan = await planDocsModernize({
      root: docsRoot,
      projectRoot,
      decide: { connection: null },
      overrides: {
        'adr/store-copy.md': { disposition: 'merge-into', target: slug, reason: 'test: link' },
      },
    });
    // Swap the planned file for a symlink to the kept file after planning.
    rmSync(join(docsRoot, 'adr', 'store-copy.md'));
    symlinkSync(keptAbs, join(docsRoot, 'adr', 'store-copy.md'));

    await expect(applyDocsModernize({ plan, projectRoot, allowDirty: true })).rejects.toThrow(
      /is a symlink/,
    );
    expect(readdirSync(join(docsRoot, 'adr')).sort()).toEqual([
      'adr-001-store.md',
      'store-copy.md',
    ]);
    expect(readFileSync(keptAbs, 'utf-8')).toBe(keep);
  });
});
