/**
 * Every ADR operation reads the canon ADR home (`docs/adr/`, or the `adr`
 * kind's `publishMirror` in `.cleo/canon.yml`), never the retired
 * `.cleo/adrs/` mirror, and accepts lowercase `adr-NNN-` file names (T14108).
 *
 * @task T14108
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestDb,
  optOutOfForeignKeys,
  seedTasks,
  type TestDbEnv,
} from '../../store/__tests__/test-db-helper.js';
import { findAdrs } from '../find.js';
import { listAdrFiles, resolveAdrHome } from '../home.js';
import { linkPipelineAdr } from '../link-pipeline.js';
import { listAdrs } from '../list.js';
import { extractAdrId } from '../parse.js';
import { showAdr } from '../show.js';
import { syncAdrsToDb } from '../sync.js';
import { validateAllAdrs } from '../validate.js';

const ALPHA = `# ADR-001: Alpha decision

**Date**: 2026-01-01
**Status**: accepted
**Accepted**: 2026-01-02
**Related Tasks**: T001
**Keywords**: alpha, storage

---

## Decision

Alpha.
`;

const BETA = `# ADR-002: Beta decision

**Date**: 2026-01-03
**Status**: superseded
**Superseded By**: adr-001-alpha

---

## Decision

Beta.
`;

const LEGACY = `# ADR-003: Legacy mirror only

**Date**: 2026-01-04
**Status**: accepted
**Accepted**: 2026-01-04

---
`;

function write(root: string, rel: string, text: string): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, text);
}

// The ADR writers still use the bare adr_task_links twin, whose task FK points at the
// empty bare tasks table (T13118). Until T13118 lands, this file tests where ADRs are
// read from, not that FK.
optOutOfForeignKeys();

describe('ADR home (T14108)', () => {
  let env: TestDbEnv;
  let root: string;

  beforeEach(async () => {
    env = await createTestDb();
    root = env.tempDir;
    write(root, 'docs/adr/adr-001-alpha.md', ALPHA);
    write(root, 'docs/adr/ADR-002-beta.md', BETA);
    write(root, 'docs/adr/README.md', '# not an ADR\n');
    // A stale legacy mirror file must be ignored.
    write(root, '.cleo/adrs/ADR-003-legacy.md', LEGACY);
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it('resolves docs/adr by default and reads only ADR files there, case-insensitively', () => {
    expect(resolveAdrHome(root)).toBe('docs/adr');
    expect(listAdrFiles(root).map((f) => f.relPath)).toEqual([
      'docs/adr/adr-001-alpha.md',
      'docs/adr/ADR-002-beta.md',
    ]);
    expect(extractAdrId('adr-001-alpha.md')).toBe('ADR-001');
  });

  it('follows the adr publishMirror declared in .cleo/canon.yml', () => {
    write(
      root,
      '.cleo/canon.yml',
      'version: 1\nkinds:\n  adr:\n    canonicalHome: ssot\n    publishMirror: decisions/\n    rawMdAllowed: false\n',
    );
    write(root, 'decisions/adr-009-elsewhere.md', ALPHA);
    expect(resolveAdrHome(root)).toBe('decisions');
    expect(listAdrFiles(root).map((f) => f.name)).toEqual(['adr-009-elsewhere.md']);
  });

  it('cleo adr list / show / find read the ADR home', async () => {
    const list = await listAdrs(root);
    expect(list.adrs.map((a) => a.id)).toEqual(['ADR-001', 'ADR-002']);
    expect(list.adrs[0]?.filePath).toBe(join(root, 'docs/adr/adr-001-alpha.md'));

    expect((await showAdr(root, { adrId: 'ADR-001' }))?.title).toBe('ADR-001: Alpha decision');
    expect((await showAdr(root, { adrId: 'adr-002' }))?.id).toBe('ADR-002');
    expect(await showAdr(root, { adrId: 'ADR-003' })).toBeNull();

    const found = await findAdrs(root, { query: 'alpha' });
    expect(found.adrs.map((a) => a.id)).toEqual(['ADR-001']);
  });

  it('cleo adr validate checks the ADR home against the schema @cleocode/core ships', async () => {
    const result = await validateAllAdrs(root);
    expect(result.errors).toEqual([]);
    expect(result).toMatchObject({ valid: true, checked: 2 });
  });

  it('cleo adr sync and the pipeline link record docs/adr paths', async () => {
    await seedTasks(env.accessor, [{ id: 'T001', title: 'Owner task', description: 'owner' }]);

    const sync = await syncAdrsToDb(root);
    expect(sync.errors).toEqual([]);
    expect(sync.inserted).toBe(2);

    const link = await linkPipelineAdr(root, 'T001');
    expect(link.errors).toEqual([]);
    expect(link.linked).toEqual([{ adrId: 'ADR-001', taskId: 'T001' }]);

    const { getDb } = await import('../../store/sqlite.js');
    const { architectureDecisions } = await import('../../store/tasks-schema.js');
    const rows = await (await getDb(root))
      .select({
        id: architectureDecisions.id,
        filePath: architectureDecisions.filePath,
        supersededById: architectureDecisions.supersededById,
      })
      .from(architectureDecisions)
      .all();
    expect(rows.sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: 'ADR-001', filePath: 'docs/adr/adr-001-alpha.md', supersededById: null },
      { id: 'ADR-002', filePath: 'docs/adr/ADR-002-beta.md', supersededById: 'ADR-001' },
    ]);
  });
});
