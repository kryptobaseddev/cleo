/**
 * `cleo docs modernize` tree apply on a case-insensitive filesystem (T14610):
 * a case-only rename keeps the file, and a moved published mirror takes its
 * `docs_publications` row with it.
 *
 * Case-insensitive lookup is simulated on any host: under the docs root,
 * every path given to `node:fs` resolves to the existing entry whose name
 * matches ignoring case, as APFS and NTFS resolve it. A rename onto such a
 * name therefore lands in the old entry, which keeps its old spelling.
 *
 * @task T14610
 */

import { createHash } from 'node:crypto';
import type * as Fs from 'node:fs';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type * as FsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb } from '../../../store/sqlite.js';
import { statusDocs } from '../../docs-ops.js';
import { readDocsPublications, upsertDocsPublication } from '../../publications-store.js';
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
    readFile: (p: Fs.PathLike, o?: never) => real.readFile(f(p), o),
    writeFile: (p: Fs.PathLike, d: string | Uint8Array) => real.writeFile(f(p), d),
    rename: (a: Fs.PathLike, b: Fs.PathLike) => real.rename(f(a), f(b)),
    rm: (p: Fs.PathLike, o?: Fs.RmOptions) => real.rm(f(p), o),
  };
});

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

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
});
