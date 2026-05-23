/**
 * Integration test for `cleo doctor db-substrate` (T10307 / Saga T10281
 * SG-BRAIN-DB-RESILIENCE / Epic T10282 E1-DB-INVENTORY).
 *
 * Verifies:
 *   - The substrate survey returns one entry per DB_INVENTORY role.
 *   - Existing DBs report `exists: true`, `integrityOK: true`, populated
 *     row counts, and non-null mtime/size.
 *   - Missing DBs report `exists: false` with all DB-dependent fields null.
 *   - Corrupt DBs report `integrityOK: false` and carry `suggestedFix`
 *     pointing at `cleo backup recover <role>`.
 *   - `--fleet` mode aggregates multiple projects + reuses cached global-tier
 *     findings (single integrity_check per global file).
 *   - Orphan-project-root and nested-nexus-duplicate warnings fire when
 *     the corresponding fixtures are present.
 *
 * Uses a sandboxed `mkdtempSync` 2-project fixture per the T10307 spec.
 *
 * @task T10307
 * @epic T10282
 * @saga T10281
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { DB_INVENTORY } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// Direct-path import matches the pattern used by other CLI integration
// tests that need core primitives without an alias rewrite (saga-audit
// uses the same approach).
import {
  detectOrphanProjectRootWarning,
  isLegitimateCleoProjectRoot,
  readParentWorkspace,
  resolveInventoryFilePath,
  surveyDbSubstrate,
  surveyFleetDbSubstrate,
} from '../../../../../core/src/doctor/db-substrate.js';

const _require = createRequire(import.meta.url);
const { DatabaseSync: DatabaseSyncCtor } = _require('node:sqlite') as {
  DatabaseSync: new (...args: ConstructorParameters<typeof DatabaseSync>) => DatabaseSync;
};

/** Create a tiny well-formed SQLite DB with a single table + row at the given path. */
function seedHealthyDb(dbPath: string): void {
  const writer = new DatabaseSyncCtor(dbPath);
  writer.exec(
    `CREATE TABLE rows (id INTEGER PRIMARY KEY, label TEXT NOT NULL);
     INSERT INTO rows (label) VALUES ('alpha'), ('beta');`,
  );
  writer.close();
}

/**
 * Write a clearly malformed file at the given path so the survey
 * surfaces `integrityOK: false` (or throws on open + surfaces an error
 * string). Either path is acceptable for the corrupt-detection contract.
 */
function seedCorruptDb(dbPath: string): void {
  writeFileSync(dbPath, 'this is not a sqlite database; integrity will fail');
}

describe('doctor db-substrate (T10307)', () => {
  let fleetRoot: string;
  let originalHome: string | undefined;
  let originalRoot: string | undefined;
  let originalProjectRoot: string | undefined;
  let cleoHomeOverride: string;

  beforeEach(() => {
    fleetRoot = mkdtempSync(join(tmpdir(), 'cleo-substrate-fleet-'));
    cleoHomeOverride = mkdtempSync(join(tmpdir(), 'cleo-substrate-home-'));
    originalHome = process.env['CLEO_HOME'];
    originalRoot = process.env['CLEO_ROOT'];
    originalProjectRoot = process.env['CLEO_PROJECT_ROOT'];
    process.env['CLEO_HOME'] = cleoHomeOverride;
    // Reset platform-paths cache so CLEO_HOME override is honoured.
    // Mutating env vars after module import requires us to clear any
    // cached resolver state in `@cleocode/paths`.
    void import('@cleocode/paths').then(({ _resetCleoPlatformPathsCache }) =>
      _resetCleoPlatformPathsCache(),
    );
  });

  afterEach(() => {
    if (originalHome !== undefined) process.env['CLEO_HOME'] = originalHome;
    else delete process.env['CLEO_HOME'];
    if (originalRoot !== undefined) process.env['CLEO_ROOT'] = originalRoot;
    else delete process.env['CLEO_ROOT'];
    if (originalProjectRoot !== undefined) process.env['CLEO_PROJECT_ROOT'] = originalProjectRoot;
    else delete process.env['CLEO_PROJECT_ROOT'];

    try {
      rmSync(fleetRoot, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup.
    }
    try {
      rmSync(cleoHomeOverride, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup.
    }
  });

  /**
   * Create a project directory under `fleetRoot` and seed only a healthy
   * `tasks.db` inside `<projectRoot>/.cleo/`. Every other inventory entry
   * is left absent so the survey can verify the `exists: false` branch.
   */
  function createProjectWithTasksDb(name: string): string {
    const projectRoot = join(fleetRoot, name);
    const cleoDir = join(projectRoot, '.cleo');
    mkdirSync(cleoDir, { recursive: true });
    seedHealthyDb(join(cleoDir, 'tasks.db'));
    return projectRoot;
  }

  it('surveys every DB_INVENTORY role + reports exists/integrity per file', async () => {
    await import('@cleocode/paths').then(({ _resetCleoPlatformPathsCache }) =>
      _resetCleoPlatformPathsCache(),
    );
    const projectRoot = createProjectWithTasksDb('project-a');

    const result = surveyDbSubstrate(projectRoot);

    expect(result.scope).toBe('project');
    expect(result.projects).toHaveLength(1);

    const survey = result.projects[0];
    expect(survey).toBeDefined();
    if (!survey) throw new Error('survey absent');
    expect(survey.projectRoot).toBe(projectRoot);
    expect(survey.projectId.length).toBe(32);

    // Every inventory role MUST be keyed in the survey.
    for (const inventoryEntry of DB_INVENTORY) {
      expect(survey.dbs[inventoryEntry.role]).toBeDefined();
    }

    const tasks = survey.dbs['tasks'];
    expect(tasks).toBeDefined();
    if (!tasks) throw new Error('tasks entry absent');
    expect(tasks.exists).toBe(true);
    expect(tasks.integrityOK).toBe(true);
    expect(tasks.rowCounts).not.toBeNull();
    expect(tasks.lastWriteMs).not.toBeNull();
    expect(tasks.sizeBytes).not.toBeNull();
    expect(tasks.error).toBeNull();
    expect(tasks.suggestedFix).toBeNull();

    // brain.db wasn't seeded — should be exists: false.
    const brain = survey.dbs['brain'];
    expect(brain).toBeDefined();
    if (!brain) throw new Error('brain entry absent');
    expect(brain.exists).toBe(false);
    expect(brain.integrityOK).toBeNull();
    expect(brain.rowCounts).toBeNull();
    expect(brain.error).toBeNull();
  });

  it('surfaces integrityOK=false + suggestedFix when the DB is corrupt', async () => {
    await import('@cleocode/paths').then(({ _resetCleoPlatformPathsCache }) =>
      _resetCleoPlatformPathsCache(),
    );
    const projectRoot = createProjectWithTasksDb('project-corrupt');

    // Overwrite tasks.db with garbage AFTER seedHealthyDb wrote it.
    seedCorruptDb(join(projectRoot, '.cleo', 'tasks.db'));

    const result = surveyDbSubstrate(projectRoot);
    const survey = result.projects[0];
    if (!survey) throw new Error('survey absent');

    const tasks = survey.dbs['tasks'];
    if (!tasks) throw new Error('tasks entry absent');
    expect(tasks.exists).toBe(true);
    expect(tasks.integrityOK).toBe(false);
    expect(tasks.suggestedFix).toBe('cleo backup recover tasks');

    // Either error is non-null (open threw) OR integrityOK rolled to false
    // via a non-'ok' pragma result — both branches satisfy the corrupt
    // contract.
    expect(tasks.error !== null || tasks.integrityOK === false).toBe(true);

    expect(result.summary.corrupt).toBeGreaterThanOrEqual(1);
  });

  it('walks --fleet mode and aggregates multiple projects', async () => {
    await import('@cleocode/paths').then(({ _resetCleoPlatformPathsCache }) =>
      _resetCleoPlatformPathsCache(),
    );
    createProjectWithTasksDb('project-a');
    createProjectWithTasksDb('project-b');

    const result = surveyFleetDbSubstrate(fleetRoot);

    expect(result.scope).toBe('fleet');
    expect(result.projects.length).toBe(2);
    const roots = result.projects.map((p) => p.projectRoot).sort();
    expect(roots).toEqual([join(fleetRoot, 'project-a'), join(fleetRoot, 'project-b')]);

    // Every project's tasks.db should be healthy.
    for (const survey of result.projects) {
      const tasks = survey.dbs['tasks'];
      expect(tasks).toBeDefined();
      if (!tasks) continue;
      expect(tasks.exists).toBe(true);
      expect(tasks.integrityOK).toBe(true);
    }

    // Fleet mode shares global-tier findings across projects — both
    // surveys should reference the SAME global-tier DbSubstrateEntry
    // object for nexus.db (cache reuse).
    const first = result.projects[0];
    const second = result.projects[1];
    if (first && second) {
      expect(first.dbs['nexus']).toBe(second.dbs['nexus']);
    }
  });

  it('detects orphan-project-root warning when fleetRoot itself has a .cleo/', () => {
    // Seed orphan .cleo/ at the fleet root path. Per the audit, this is
    // exactly the T9550 regression class case (/mnt/projects/.cleo/).
    mkdirSync(join(fleetRoot, '.cleo'));
    createProjectWithTasksDb('child-project');

    const result = surveyFleetDbSubstrate(fleetRoot);
    const orphans = result.warnings.filter((w) => w.kind === 'orphan-project-root');
    expect(orphans.length).toBe(1);
    expect(orphans[0]?.path).toBe(join(fleetRoot, '.cleo'));
  });

  it('detects orphan-project-root via single-project survey when parent has .cleo/', () => {
    // Single-project mode also surfaces a parent-directory orphan
    // (the project lives at fleetRoot/child, and fleetRoot/.cleo exists).
    mkdirSync(join(fleetRoot, '.cleo'));
    const projectRoot = createProjectWithTasksDb('child');

    const warning = detectOrphanProjectRootWarning(projectRoot);
    expect(warning).not.toBeNull();
    expect(warning?.kind).toBe('orphan-project-root');
    expect(warning?.path).toBe(join(fleetRoot, '.cleo'));

    const result = surveyDbSubstrate(projectRoot);
    const orphans = result.warnings.filter((w) => w.kind === 'orphan-project-root');
    expect(orphans.length).toBe(1);
  });

  it('detects nested-nexus-duplicate warnings when <cleoHome>/nexus/*.db exists', async () => {
    // Re-reset paths cache after the CLEO_HOME env mutation in beforeEach.
    await import('@cleocode/paths').then(({ _resetCleoPlatformPathsCache }) =>
      _resetCleoPlatformPathsCache(),
    );

    // Seed both nested-nexus duplicates under <cleoHome>/nexus/.
    mkdirSync(join(cleoHomeOverride, 'nexus'), { recursive: true });
    writeFileSync(join(cleoHomeOverride, 'nexus', 'nexus.db'), 'placeholder');
    writeFileSync(join(cleoHomeOverride, 'nexus', 'signaldock.db'), 'placeholder');

    const projectRoot = createProjectWithTasksDb('nested-nexus-project');
    const result = surveyDbSubstrate(projectRoot);
    const nested = result.warnings.filter((w) => w.kind === 'nested-nexus-duplicate');
    expect(nested.length).toBe(2);
    const paths = nested.map((n) => n.path).sort();
    expect(paths).toContain(join(cleoHomeOverride, 'nexus', 'nexus.db'));
    expect(paths).toContain(join(cleoHomeOverride, 'nexus', 'signaldock.db'));
  });

  it('resolves filePathTemplate tokens to absolute on-disk paths', async () => {
    await import('@cleocode/paths').then(({ _resetCleoPlatformPathsCache }) =>
      _resetCleoPlatformPathsCache(),
    );
    const projectRoot = join(fleetRoot, 'token-project');

    // tasks.db is a project-tier role — should resolve under projectRoot.
    const tasksEntry = DB_INVENTORY.find((e) => e.role === 'tasks');
    expect(tasksEntry).toBeDefined();
    if (!tasksEntry) return;
    expect(resolveInventoryFilePath(tasksEntry, projectRoot)).toBe(
      join(projectRoot, '.cleo', 'tasks.db'),
    );

    // nexus.db is global-tier — should resolve under cleoHomeOverride.
    const nexusEntry = DB_INVENTORY.find((e) => e.role === 'nexus');
    expect(nexusEntry).toBeDefined();
    if (!nexusEntry) return;
    expect(resolveInventoryFilePath(nexusEntry, projectRoot)).toBe(
      join(cleoHomeOverride, 'nexus.db'),
    );
  });

  it('T10308: orphan warning suppressed when parent .cleo/ is a legitimate project (project-info.json + tasks.db)', async () => {
    await import('@cleocode/paths').then(({ _resetCleoPlatformPathsCache }) =>
      _resetCleoPlatformPathsCache(),
    );
    // Parent has a fully-legitimate CLEO project root — both markers
    // present. T10308 AC2 says we MUST NOT flag this as an orphan even
    // though `<parent>/.cleo/` exists.
    const parentCleoDir = join(fleetRoot, '.cleo');
    mkdirSync(parentCleoDir, { recursive: true });
    writeFileSync(join(parentCleoDir, 'project-info.json'), JSON.stringify({ name: 'parent' }));
    seedHealthyDb(join(parentCleoDir, 'tasks.db'));

    const childProjectRoot = createProjectWithTasksDb('child');

    expect(isLegitimateCleoProjectRoot(parentCleoDir)).toBe(true);
    expect(detectOrphanProjectRootWarning(childProjectRoot)).toBeNull();

    const result = surveyDbSubstrate(childProjectRoot);
    const orphans = result.warnings.filter((w) => w.kind === 'orphan-project-root');
    expect(orphans.length).toBe(0);
  });

  it('T10308: orphan warning still fires when parent .cleo/ has project-info.json BUT NO tasks.db', () => {
    // Half-legitimate state — `cleo init` was started but the SQLite
    // store never materialised, OR a stray writer dropped only
    // project-info.json. Either case is an orphan per AC2.
    const parentCleoDir = join(fleetRoot, '.cleo');
    mkdirSync(parentCleoDir, { recursive: true });
    writeFileSync(join(parentCleoDir, 'project-info.json'), JSON.stringify({ name: 'half' }));

    const childProjectRoot = createProjectWithTasksDb('child');

    expect(isLegitimateCleoProjectRoot(parentCleoDir)).toBe(false);
    const warning = detectOrphanProjectRootWarning(childProjectRoot);
    expect(warning).not.toBeNull();
    expect(warning?.path).toBe(parentCleoDir);
  });

  it('T10308: orphan warning still fires when parent .cleo/ has tasks.db BUT NO project-info.json', () => {
    // The other half-legitimate state — DB was opened first via an
    // import path that bypassed `cleo init`. Still orphan per AC2.
    const parentCleoDir = join(fleetRoot, '.cleo');
    mkdirSync(parentCleoDir, { recursive: true });
    seedHealthyDb(join(parentCleoDir, 'tasks.db'));

    const childProjectRoot = createProjectWithTasksDb('child');

    expect(isLegitimateCleoProjectRoot(parentCleoDir)).toBe(false);
    const warning = detectOrphanProjectRootWarning(childProjectRoot);
    expect(warning).not.toBeNull();
    expect(warning?.path).toBe(parentCleoDir);
  });

  it('T10308: orphan warning attributes parentWorkspace from .context-state.json', () => {
    // The 2026-05-23 live regression case: /mnt/projects/.cleo/ being
    // written from /mnt/projects/awesome-skills/. Verifies the
    // `parentWorkspace` field round-trips correctly.
    const parentCleoDir = join(fleetRoot, '.cleo');
    mkdirSync(parentCleoDir, { recursive: true });
    writeFileSync(
      join(parentCleoDir, '.context-state.json'),
      JSON.stringify({ workspace: '/mnt/projects/awesome-skills' }),
    );

    const childProjectRoot = createProjectWithTasksDb('child');

    const warning = detectOrphanProjectRootWarning(childProjectRoot);
    expect(warning).not.toBeNull();
    expect(warning?.kind).toBe('orphan-project-root');
    expect(warning?.path).toBe(parentCleoDir);
    expect(warning?.parentWorkspace).toBe('/mnt/projects/awesome-skills');

    // Round-trips through surveyDbSubstrate too.
    const result = surveyDbSubstrate(childProjectRoot);
    const surveyWarning = result.warnings.find((w) => w.kind === 'orphan-project-root');
    expect(surveyWarning?.parentWorkspace).toBe('/mnt/projects/awesome-skills');
  });

  it('T10308: parentWorkspace=null when .context-state.json is absent', () => {
    const parentCleoDir = join(fleetRoot, '.cleo');
    mkdirSync(parentCleoDir, { recursive: true });
    // No .context-state.json — orphan still fires, but parentWorkspace=null.

    const childProjectRoot = createProjectWithTasksDb('child');

    const warning = detectOrphanProjectRootWarning(childProjectRoot);
    expect(warning).not.toBeNull();
    expect(warning?.parentWorkspace).toBeNull();
  });

  it('T10308: parentWorkspace=null when .context-state.json is unparseable', () => {
    const parentCleoDir = join(fleetRoot, '.cleo');
    mkdirSync(parentCleoDir, { recursive: true });
    writeFileSync(join(parentCleoDir, '.context-state.json'), '{ malformed json');

    const childProjectRoot = createProjectWithTasksDb('child');

    expect(readParentWorkspace(parentCleoDir)).toBeNull();
    const warning = detectOrphanProjectRootWarning(childProjectRoot);
    expect(warning?.parentWorkspace).toBeNull();
  });

  it('T10308: parentWorkspace=null when workspace field is missing or non-string', () => {
    const parentCleoDir = join(fleetRoot, '.cleo');
    mkdirSync(parentCleoDir, { recursive: true });
    writeFileSync(
      join(parentCleoDir, '.context-state.json'),
      JSON.stringify({ workspace: 42, other: 'data' }),
    );

    expect(readParentWorkspace(parentCleoDir)).toBeNull();
  });

  it('T10308: fleet mode suppresses orphan when fleetRoot itself is a legitimate project', () => {
    // Fleet-mode mirror of the single-project legitimacy check. If the
    // fleetRoot directory itself looks like a real CLEO project, we
    // should NOT flag its .cleo/ as orphan.
    const fleetCleoDir = join(fleetRoot, '.cleo');
    mkdirSync(fleetCleoDir, { recursive: true });
    writeFileSync(join(fleetCleoDir, 'project-info.json'), JSON.stringify({ name: 'root' }));
    seedHealthyDb(join(fleetCleoDir, 'tasks.db'));
    createProjectWithTasksDb('child-project');

    const result = surveyFleetDbSubstrate(fleetRoot);
    const orphans = result.warnings.filter((w) => w.kind === 'orphan-project-root');
    expect(orphans.length).toBe(0);
  });

  it('aggregates summary counters across all inventory entries', async () => {
    await import('@cleocode/paths').then(({ _resetCleoPlatformPathsCache }) =>
      _resetCleoPlatformPathsCache(),
    );
    const projectRoot = createProjectWithTasksDb('summary-project');
    const result = surveyDbSubstrate(projectRoot);

    // total = #entries × 1 project (project mode); healthy + missing + corrupt = total.
    expect(result.summary.totalDbs).toBe(DB_INVENTORY.length);
    expect(result.summary.healthy + result.summary.missing + result.summary.corrupt).toBe(
      result.summary.totalDbs,
    );
    expect(result.summary.healthy).toBeGreaterThanOrEqual(1);
  });
});
