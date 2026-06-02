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

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { DB_INVENTORY } from '@cleocode/contracts';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// Direct-path import matches the pattern used by other CLI integration
// tests that need core primitives without an alias rewrite (saga-audit
// uses the same approach).
import {
  checkInvariantI1,
  checkInvariantI2,
  checkInvariantI3,
  checkInvariantI4,
  checkInvariantI5,
  computeSubstrateProjectId,
  detectOrphanProjectRootWarning,
  isLegitimateCleoProjectRoot,
  readParentWorkspace,
  resolveInventoryFilePath,
  resolveInventoryMigrationsFolder,
  surveyDbSubstrate,
  surveyFleetDbSubstrate,
  walkCrossDbInvariants,
  walkPragmaDrift,
} from '../../../../../core/src/doctor/db-substrate.js';
import {
  loadPragmaSsot,
  normalisePragmaValue,
} from '../../../../../core/src/doctor/pragma-ssot.js';

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
 * Seed a DB with a populated `__drizzle_migrations` journal AND a
 * placeholder data table. The journal entries come from
 * `readMigrationFiles` so the hashes match the real on-disk migrations
 * for the given role. T10311 migration-coverage fixtures rely on this.
 *
 * @param dbPath - Absolute path to the SQLite file to create.
 * @param migrationsFolder - Absolute path to the role's migrationsDir.
 * @param options.skipLastN - When `> 0`, omit the last N hashes from the
 *   journal so the coverage check detects missing files.
 * @param options.includeOrphanHash - When non-null, additionally insert
 *   this hash as a fake row (not present on disk) to trigger an
 *   orphan-row detection.
 */
function seedDbWithMigrationJournal(
  dbPath: string,
  migrationsFolder: string,
  options: { skipLastN?: number; includeOrphanHash?: string | null } = {},
): void {
  const writer = new DatabaseSyncCtor(dbPath);
  // Placeholder data table so the substrate audit's integrity_check +
  // rowCounts paths still execute against a non-trivial schema.
  writer.exec(
    `CREATE TABLE rows (id INTEGER PRIMARY KEY, label TEXT NOT NULL);
     INSERT INTO rows (label) VALUES ('alpha');`,
  );
  // Drizzle canonical journal schema.
  writer.exec(
    `CREATE TABLE __drizzle_migrations (
       id INTEGER PRIMARY KEY,
       hash text NOT NULL,
       created_at numeric,
       name text,
       applied_at TEXT
     );`,
  );

  const migrations = readMigrationFiles({ migrationsFolder });
  const skip = options.skipLastN ?? 0;
  const cutoff = Math.max(0, migrations.length - skip);
  const insert = writer.prepare(
    'INSERT INTO __drizzle_migrations (hash, created_at, name) VALUES (?, ?, ?)',
  );
  for (let i = 0; i < cutoff; i += 1) {
    const m = migrations[i];
    if (!m) continue;
    insert.run(m.hash, m.folderMillis, m.name);
  }

  if (options.includeOrphanHash != null) {
    insert.run(options.includeOrphanHash, Date.now(), 'fake-orphan-migration');
  }

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
    // T10312 fields: healthy DB has no quarantine + non-null elapsed.
    expect(tasks.quarantinedTo).toBeNull();
    expect(tasks.integrityCheckMs).not.toBeNull();
    expect(tasks.timedOut).toBe(false);

    // brain.db wasn't seeded — should be exists: false.
    const brain = survey.dbs['brain'];
    expect(brain).toBeDefined();
    if (!brain) throw new Error('brain entry absent');
    expect(brain.exists).toBe(false);
    expect(brain.integrityOK).toBeNull();
    expect(brain.rowCounts).toBeNull();
    expect(brain.error).toBeNull();
    // T10312 fields: missing DB has null elapsed + no quarantine.
    expect(brain.quarantinedTo).toBeNull();
    expect(brain.integrityCheckMs).toBeNull();
    expect(brain.timedOut).toBe(false);
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
    // Default auto-quarantine fires — suggestedFix carries the recovery
    // cmd + the quarantine path inline. The hard recovery command stays
    // canonical at the start of the string.
    expect(tasks.suggestedFix).not.toBeNull();
    expect(tasks.suggestedFix).toContain('cleo backup recover tasks');

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

  // ============================================================================
  // T10311 — per-DB Drizzle migration coverage cross-check
  // ============================================================================

  it('T10311: reports null migrationCoverage when DB has no __drizzle_migrations table', async () => {
    // `seedHealthyDb` creates a placeholder `rows` table but no journal.
    // Coverage must be null — the DB hasn't been bootstrapped yet.
    await import('@cleocode/paths').then(({ _resetCleoPlatformPathsCache }) =>
      _resetCleoPlatformPathsCache(),
    );
    const projectRoot = createProjectWithTasksDb('no-journal');
    const result = surveyDbSubstrate(projectRoot);
    const tasks = result.projects[0]?.dbs['tasks'];
    expect(tasks?.exists).toBe(true);
    expect(tasks?.integrityOK).toBe(true);
    expect(tasks?.migrationCoverage).toBeNull();
  });

  it('T10311: reports null migrationCoverage for derived/reserved roles (migrationsDir=null)', async () => {
    await import('@cleocode/paths').then(({ _resetCleoPlatformPathsCache }) =>
      _resetCleoPlatformPathsCache(),
    );
    const projectRoot = createProjectWithTasksDb('derived-role-project');
    // Manifest is a `derived` role with migrationsDir=null. Seed a healthy
    // DB at its inventory path so we exercise the success path through
    // inspectDbFile but with the early-return branch on coverage.
    const manifestEntry = DB_INVENTORY.find((e) => e.role === 'manifest');
    expect(manifestEntry).toBeDefined();
    if (!manifestEntry) return;
    expect(manifestEntry.migrationsDir).toBeNull();
    const manifestPath = resolveInventoryFilePath(manifestEntry, projectRoot);
    mkdirSync(join(projectRoot, '.cleo', 'blobs'), { recursive: true });
    // Build a manifest.db with a populated journal that would otherwise
    // confuse a less-careful check.
    const tasksFolder = resolveInventoryMigrationsFolder('packages/core/migrations/drizzle-tasks/');
    seedDbWithMigrationJournal(manifestPath, tasksFolder);

    const result = surveyDbSubstrate(projectRoot);
    const manifest = result.projects[0]?.dbs['manifest'];
    expect(manifest?.exists).toBe(true);
    // migrationsDir=null short-circuits even though the DB has a journal.
    expect(manifest?.migrationCoverage).toBeNull();
  });

  it('T10311: healthy when every file has a journal row AND every row matches a file', async () => {
    await import('@cleocode/paths').then(({ _resetCleoPlatformPathsCache }) =>
      _resetCleoPlatformPathsCache(),
    );
    const projectRoot = join(fleetRoot, 'healthy-coverage');
    mkdirSync(join(projectRoot, '.cleo'), { recursive: true });
    const tasksFolder = resolveInventoryMigrationsFolder('packages/core/migrations/drizzle-tasks/');
    const onDisk = readMigrationFiles({ migrationsFolder: tasksFolder });
    seedDbWithMigrationJournal(join(projectRoot, '.cleo', 'tasks.db'), tasksFolder);

    const result = surveyDbSubstrate(projectRoot);
    const tasks = result.projects[0]?.dbs['tasks'];
    expect(tasks?.exists).toBe(true);
    expect(tasks?.integrityOK).toBe(true);
    expect(tasks?.migrationCoverage).not.toBeNull();
    expect(tasks?.migrationCoverage?.applied).toBe(onDisk.length);
    expect(tasks?.migrationCoverage?.expected).toBe(onDisk.length);
    expect(tasks?.migrationCoverage?.orphanRows).toEqual([]);
    expect(tasks?.migrationCoverage?.missingFiles).toEqual([]);
  });

  it('T10311: detects orphan-row when journal carries a hash not on disk', async () => {
    await import('@cleocode/paths').then(({ _resetCleoPlatformPathsCache }) =>
      _resetCleoPlatformPathsCache(),
    );
    const projectRoot = join(fleetRoot, 'orphan-row');
    mkdirSync(join(projectRoot, '.cleo'), { recursive: true });
    const tasksFolder = resolveInventoryMigrationsFolder('packages/core/migrations/drizzle-tasks/');
    // Real-looking SHA-256 that will never collide with any on-disk hash.
    const fakeHash = 'deadbeef'.repeat(8);
    seedDbWithMigrationJournal(join(projectRoot, '.cleo', 'tasks.db'), tasksFolder, {
      includeOrphanHash: fakeHash,
    });

    const result = surveyDbSubstrate(projectRoot);
    const tasks = result.projects[0]?.dbs['tasks'];
    expect(tasks?.migrationCoverage).not.toBeNull();
    const coverage = tasks?.migrationCoverage;
    if (!coverage) throw new Error('coverage absent');
    expect(coverage.orphanRows.length).toBe(1);
    expect(coverage.orphanRows[0]?.hash).toBe(fakeHash);
    expect(coverage.orphanRows[0]?.createdAt).not.toBeNull();
    expect(coverage.missingFiles).toEqual([]);
    // applied = expected + 1 because we injected the orphan on top.
    expect(coverage.applied).toBe(coverage.expected + 1);
  });

  it('T10311: detects missing-file when on-disk migration has no journal row', async () => {
    await import('@cleocode/paths').then(({ _resetCleoPlatformPathsCache }) =>
      _resetCleoPlatformPathsCache(),
    );
    const projectRoot = join(fleetRoot, 'missing-file');
    mkdirSync(join(projectRoot, '.cleo'), { recursive: true });
    const tasksFolder = resolveInventoryMigrationsFolder('packages/core/migrations/drizzle-tasks/');
    const onDisk = readMigrationFiles({ migrationsFolder: tasksFolder });
    // Skip the last 2 hashes from the journal to simulate migrations that
    // were never applied yet. Drizzle's `migrate()` would pick them up on
    // next open — the survey just needs to surface them.
    seedDbWithMigrationJournal(join(projectRoot, '.cleo', 'tasks.db'), tasksFolder, {
      skipLastN: 2,
    });

    const result = surveyDbSubstrate(projectRoot);
    const tasks = result.projects[0]?.dbs['tasks'];
    expect(tasks?.migrationCoverage).not.toBeNull();
    const coverage = tasks?.migrationCoverage;
    if (!coverage) throw new Error('coverage absent');
    expect(coverage.orphanRows).toEqual([]);
    expect(coverage.missingFiles.length).toBe(2);
    expect(coverage.applied).toBe(onDisk.length - 2);
    expect(coverage.expected).toBe(onDisk.length);
    // Names of the missing migrations are the LAST 2 alphabetically — the
    // ones we deliberately omitted.
    const lastTwoNames = onDisk
      .slice(-2)
      .map((m) => m.name)
      .sort();
    const missingNames = coverage.missingFiles.map((m) => m.name).sort();
    expect(missingNames).toEqual(lastTwoNames);
  });

  it('T10311: detects both orphan-rows AND missing-files simultaneously', async () => {
    await import('@cleocode/paths').then(({ _resetCleoPlatformPathsCache }) =>
      _resetCleoPlatformPathsCache(),
    );
    const projectRoot = join(fleetRoot, 'both-drifts');
    mkdirSync(join(projectRoot, '.cleo'), { recursive: true });
    const tasksFolder = resolveInventoryMigrationsFolder('packages/core/migrations/drizzle-tasks/');
    seedDbWithMigrationJournal(join(projectRoot, '.cleo', 'tasks.db'), tasksFolder, {
      skipLastN: 1,
      includeOrphanHash: 'cafebabe'.repeat(8),
    });

    const result = surveyDbSubstrate(projectRoot);
    const tasks = result.projects[0]?.dbs['tasks'];
    const coverage = tasks?.migrationCoverage;
    if (!coverage) throw new Error('coverage absent');
    expect(coverage.orphanRows.length).toBe(1);
    expect(coverage.missingFiles.length).toBe(1);
  });

  it('T10311: resolveInventoryMigrationsFolder normalizes trailing slash', () => {
    // Inventory entries use a trailing slash; the resolver must handle
    // both that form and the slashless form for symmetry.
    const withSlash = resolveInventoryMigrationsFolder('packages/core/migrations/drizzle-tasks/');
    const withoutSlash = resolveInventoryMigrationsFolder('packages/core/migrations/drizzle-tasks');
    expect(withSlash).toBe(withoutSlash);
    expect(withSlash.endsWith('drizzle-tasks')).toBe(true);
  });

  // ──────────────────────────────────────────────────────────────────────
  // T10310 — Per-DB pragma drift detection
  // ──────────────────────────────────────────────────────────────────────

  it('T10310: pragma SSoT loader resolves canonical entries for every drift pragma', () => {
    const ssot = loadPragmaSsot();
    expect(ssot.driftPragmas.length).toBe(6);
    expect(ssot.driftPragmas).toContain('journal_mode');
    expect(ssot.driftPragmas).toContain('busy_timeout');
    expect(ssot.driftPragmas).toContain('foreign_keys');
    expect(ssot.driftPragmas).toContain('synchronous');
    expect(ssot.driftPragmas).toContain('page_size');
    expect(ssot.driftPragmas).toContain('application_id');

    // Every drift pragma MUST resolve to a non-empty expected value.
    for (const name of ssot.driftPragmas) {
      const expected = ssot.expectedByName.get(name.toLowerCase());
      expect(expected).toBeDefined();
      expect(typeof expected).toBe('string');
      expect((expected ?? '').length).toBeGreaterThan(0);
    }
  });

  it('T10310: normalisePragmaValue resolves integer codes to symbolic names', () => {
    expect(normalisePragmaValue('synchronous', '1')).toBe('NORMAL');
    expect(normalisePragmaValue('synchronous', '2')).toBe('FULL');
    expect(normalisePragmaValue('foreign_keys', '0')).toBe('OFF');
    expect(normalisePragmaValue('foreign_keys', '1')).toBe('ON');
    // Non-coded pragmas just upper-case.
    expect(normalisePragmaValue('journal_mode', 'wal')).toBe('WAL');
    expect(normalisePragmaValue('page_size', '4096')).toBe('4096');
  });

  it('T10310: pragmaDrift is null when the DB does not exist', async () => {
    await import('@cleocode/paths').then(({ _resetCleoPlatformPathsCache }) =>
      _resetCleoPlatformPathsCache(),
    );
    const projectRoot = join(fleetRoot, 'no-db-project');
    mkdirSync(join(projectRoot, '.cleo'), { recursive: true });
    // Intentionally do NOT seed tasks.db — survey should produce a missing entry.

    const result = surveyDbSubstrate(projectRoot);
    const tasks = result.projects[0]?.dbs['tasks'];
    expect(tasks).toBeDefined();
    if (!tasks) throw new Error('tasks entry absent');
    expect(tasks.exists).toBe(false);
    expect(tasks.pragmaDrift).toBeNull();
  });

  it('T10310: pragmaDrift is null when the DB is corrupt (integrityOK=false)', async () => {
    await import('@cleocode/paths').then(({ _resetCleoPlatformPathsCache }) =>
      _resetCleoPlatformPathsCache(),
    );
    const projectRoot = createProjectWithTasksDb('corrupt-pragma-project');
    seedCorruptDb(join(projectRoot, '.cleo', 'tasks.db'));

    const result = surveyDbSubstrate(projectRoot);
    const tasks = result.projects[0]?.dbs['tasks'];
    if (!tasks) throw new Error('tasks entry absent');
    expect(tasks.integrityOK).toBe(false);
    expect(tasks.pragmaDrift).toBeNull();
  });

  it('T10310: pragmaDrift surfaces busy_timeout drift on a freshly-created DB', async () => {
    // A freshly-created node:sqlite DB defaults to busy_timeout=0, but the
    // SSoT expects 30000. A raw read-only snapshot (no applyPragmas) will
    // therefore report drift on `busy_timeout`. Same for `foreign_keys`
    // (default 0/OFF) and `synchronous` (default 2/FULL). page_size + journal_mode
    // + application_id will match the SSoT defaults (4096, no-WAL, 0 stamp).
    await import('@cleocode/paths').then(({ _resetCleoPlatformPathsCache }) =>
      _resetCleoPlatformPathsCache(),
    );
    const projectRoot = createProjectWithTasksDb('drift-project');

    const result = surveyDbSubstrate(projectRoot);
    const tasks = result.projects[0]?.dbs['tasks'];
    if (!tasks) throw new Error('tasks entry absent');
    expect(tasks.integrityOK).toBe(true);
    expect(tasks.pragmaDrift).not.toBeNull();
    const drift = tasks.pragmaDrift ?? [];
    const pragmas = drift.map((d) => d.pragma);
    // busy_timeout will drift (default 0 vs canonical 30000).
    expect(pragmas).toContain('busy_timeout');
    // journal_mode WILL drift on a fresh DB because seedHealthyDb does
    // not switch the file to WAL — default is `delete`.
    expect(pragmas).toContain('journal_mode');
    // The journal_mode drift entry should record the actual on-disk mode.
    const journalEntry = drift.find((d) => d.pragma === 'journal_mode');
    expect(journalEntry?.expected).toBe('WAL');
    expect((journalEntry?.actual ?? '').toLowerCase()).not.toBe('wal');
  });

  it('T10310: pragmaDrift detects an explicitly overridden persistent pragma', async () => {
    // Explicitly override journal_mode to `delete` AND application_id to a
    // non-canonical value on disk, then verify the survey surfaces both as
    // drift items.
    await import('@cleocode/paths').then(({ _resetCleoPlatformPathsCache }) =>
      _resetCleoPlatformPathsCache(),
    );
    const projectRoot = createProjectWithTasksDb('override-pragma-project');
    const dbPath = join(projectRoot, '.cleo', 'tasks.db');

    const writer = new DatabaseSyncCtor(dbPath);
    try {
      writer.exec('PRAGMA journal_mode = DELETE');
      writer.exec('PRAGMA application_id = 12345');
    } finally {
      writer.close();
    }

    const result = surveyDbSubstrate(projectRoot);
    const tasks = result.projects[0]?.dbs['tasks'];
    if (!tasks) throw new Error('tasks entry absent');
    const drift = tasks.pragmaDrift ?? [];

    const journal = drift.find((d) => d.pragma === 'journal_mode');
    expect(journal).toBeDefined();
    expect(journal?.expected).toBe('WAL');
    expect((journal?.actual ?? '').toLowerCase()).toBe('delete');

    const appId = drift.find((d) => d.pragma === 'application_id');
    expect(appId).toBeDefined();
    expect(appId?.expected).toBe('0');
    expect(appId?.actual).toBe('12345');
  });

  it('T10310: walkPragmaDrift reports zero drift when every queried pragma matches the SSoT', () => {
    // Construct an in-memory DB and explicitly set every drift pragma to
    // its canonical value, then assert the walker reports zero drift.
    const db = new DatabaseSyncCtor(':memory:');
    try {
      // page_size MUST be set before any table is created — picked first.
      db.exec('PRAGMA page_size = 4096');
      // Apply every canonical pragma the walker checks.
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('PRAGMA busy_timeout = 30000');
      db.exec('PRAGMA foreign_keys = ON');
      db.exec('PRAGMA synchronous = NORMAL');
      db.exec('PRAGMA application_id = 0');
      // Force a write so journal_mode + page_size persist.
      db.exec('CREATE TABLE t (id INTEGER); INSERT INTO t VALUES (1);');

      const drift = walkPragmaDrift(db);
      // :memory: has documented quirks:
      // - journal_mode cannot use WAL — falls back to `memory`.
      // - busy_timeout via `exec()` may not stick on freshly-opened
      //   :memory: handles in some node:sqlite builds.
      // The override-pragma + drift-project tests above cover the
      // file-backed real-world case. Here we assert that every OTHER
      // queried pragma (page_size, foreign_keys, synchronous,
      // application_id) is not flagged as drift after explicit
      // canonical setup.
      const drifted = drift
        .map((d) => d.pragma)
        .filter((p) => p !== 'journal_mode' && p !== 'busy_timeout');
      expect(drifted).toEqual([]);
    } finally {
      db.close();
    }
  });

  // ────────────────────────────────────────────────────────────────────
  // T10312 — bounded timeout + auto-quarantine
  // ────────────────────────────────────────────────────────────────────

  it('T10312: auto-quarantines a corrupt DB into .cleo/quarantine/<role>-malformed-<iso>/', async () => {
    await import('@cleocode/paths').then(({ _resetCleoPlatformPathsCache }) =>
      _resetCleoPlatformPathsCache(),
    );
    const projectRoot = createProjectWithTasksDb('project-auto-quarantine');
    const tasksDbPath = join(projectRoot, '.cleo', 'tasks.db');

    // Replace healthy tasks.db with garbage AFTER seedHealthyDb wrote it.
    seedCorruptDb(tasksDbPath);

    // Also create sidecar -wal + -shm so we can verify they're preserved.
    writeFileSync(`${tasksDbPath}-wal`, 'placeholder wal sidecar');
    writeFileSync(`${tasksDbPath}-shm`, 'placeholder shm sidecar');

    const result = surveyDbSubstrate(projectRoot);
    const survey = result.projects[0];
    if (!survey) throw new Error('survey absent');
    const tasks = survey.dbs['tasks'];
    if (!tasks) throw new Error('tasks entry absent');

    // Auto-quarantine fired — the structured envelope carries the path.
    expect(tasks.integrityOK).toBe(false);
    expect(tasks.quarantinedTo).not.toBeNull();
    if (tasks.quarantinedTo === null) throw new Error('quarantinedTo absent');

    // Path lives under <projectRoot>/.cleo/quarantine/tasks-malformed-<iso>/.
    expect(tasks.quarantinedTo).toContain(join(projectRoot, '.cleo', 'quarantine'));
    expect(tasks.quarantinedTo).toMatch(/tasks-malformed-/);

    // Corrupt DB has been moved off the live path.
    expect(existsSync(tasksDbPath)).toBe(false);

    // Quarantine directory contains the .malformed file + both sidecars.
    expect(existsSync(join(tasks.quarantinedTo, 'tasks.db.malformed'))).toBe(true);
    expect(existsSync(join(tasks.quarantinedTo, 'tasks.db.malformed-wal'))).toBe(true);
    expect(existsSync(join(tasks.quarantinedTo, 'tasks.db.malformed-shm'))).toBe(true);

    // suggestedFix carries the recover command + quarantine path so the
    // operator has a single one-liner without poking at structured fields.
    expect(tasks.suggestedFix).not.toBeNull();
    expect(tasks.suggestedFix).toContain('cleo backup recover tasks');
    expect(tasks.suggestedFix).toContain(tasks.quarantinedTo);
  });

  it('T10312: --no-quarantine leaves the corrupt DB in place', async () => {
    await import('@cleocode/paths').then(({ _resetCleoPlatformPathsCache }) =>
      _resetCleoPlatformPathsCache(),
    );
    const projectRoot = createProjectWithTasksDb('project-no-quarantine');
    const tasksDbPath = join(projectRoot, '.cleo', 'tasks.db');
    seedCorruptDb(tasksDbPath);

    const result = surveyDbSubstrate(projectRoot, { autoQuarantine: false });
    const survey = result.projects[0];
    if (!survey) throw new Error('survey absent');
    const tasks = survey.dbs['tasks'];
    if (!tasks) throw new Error('tasks entry absent');

    expect(tasks.integrityOK).toBe(false);
    expect(tasks.quarantinedTo).toBeNull();

    // Corrupt DB still at the live path — survey did NOT move it.
    expect(existsSync(tasksDbPath)).toBe(true);

    // suggestedFix is the canonical recover command, no quarantine
    // addendum since none happened.
    expect(tasks.suggestedFix).toBe('cleo backup recover tasks');
  });

  it('T10312: integrityCheckMs is recorded for every existing DB', async () => {
    await import('@cleocode/paths').then(({ _resetCleoPlatformPathsCache }) =>
      _resetCleoPlatformPathsCache(),
    );
    const projectRoot = createProjectWithTasksDb('project-elapsed');

    const result = surveyDbSubstrate(projectRoot);
    const survey = result.projects[0];
    if (!survey) throw new Error('survey absent');
    const tasks = survey.dbs['tasks'];
    if (!tasks) throw new Error('tasks entry absent');

    // Healthy DB: integrityCheckMs is non-null and a non-negative number.
    expect(tasks.integrityCheckMs).not.toBeNull();
    if (tasks.integrityCheckMs === null) throw new Error('integrityCheckMs null');
    expect(tasks.integrityCheckMs).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(tasks.integrityCheckMs)).toBe(true);
  });

  it('T10312: timedOut=true when integrity_check elapsed exceeds the configured budget', async () => {
    await import('@cleocode/paths').then(({ _resetCleoPlatformPathsCache }) =>
      _resetCleoPlatformPathsCache(),
    );
    const projectRoot = createProjectWithTasksDb('project-timeout');

    // A 1-row tasks.db check takes single-digit ms. Pass a ridiculously
    // small budget (integrityCheckTimeoutMs: -1 disabled; using a very
    // tight 0.0001 round-trip workaround). Easier: configure 0... but
    // 0 disables. Use 0.5 ms - but Math.floor in our impl drops sub-ms.
    // Use the SQL-side fact that `integrity_check` on even an empty DB
    // takes some non-zero ms by setting timeout to a value just below
    // the actual elapsed.
    //
    // To guarantee determinism in CI, we override the timeout to a tiny
    // value AND set autoQuarantine to false so we observe the timedOut
    // flag without the quarantine side-effect.
    //
    // We measure once to discover actual elapsed, then re-run with
    // timeout = elapsed - 1 to guarantee `timedOut: true`. If first
    // run was 0 ms (very fast DB), we fall back to timeout=0 which is
    // disabled — assertion is skipped via the `>= 0` early-out check
    // below.
    const firstPass = surveyDbSubstrate(projectRoot, { autoQuarantine: false });
    const firstTasks = firstPass.projects[0]?.dbs['tasks'];
    if (!firstTasks || firstTasks.integrityCheckMs === null) {
      throw new Error('first pass elapsed absent');
    }
    if (firstTasks.integrityCheckMs <= 1) {
      // Sub-ms check — the timeout-mechanism still works but we can't
      // assert it deterministically. Verify the timeout=0 disable branch
      // instead.
      const passWithDisabledTimeout = surveyDbSubstrate(projectRoot, {
        autoQuarantine: false,
        integrityCheckTimeoutMs: 0,
      });
      const t = passWithDisabledTimeout.projects[0]?.dbs['tasks'];
      expect(t?.timedOut).toBe(false);
      expect(t?.integrityOK).toBe(true);
      return;
    }

    const tightBudget = Math.max(0, firstTasks.integrityCheckMs - 1);
    const secondPass = surveyDbSubstrate(projectRoot, {
      autoQuarantine: false,
      integrityCheckTimeoutMs: tightBudget,
    });
    const secondTasks = secondPass.projects[0]?.dbs['tasks'];
    if (!secondTasks) throw new Error('second pass tasks entry absent');

    expect(secondTasks.timedOut).toBe(true);
    expect(secondTasks.integrityOK).toBe(false);
    expect(secondTasks.error).toContain('integrity_check exceeded timeout');
    expect(secondPass.summary.corrupt).toBeGreaterThanOrEqual(1);
  });

  it('T10312: integrityCheckTimeoutMs=0 disables the timeout', async () => {
    await import('@cleocode/paths').then(({ _resetCleoPlatformPathsCache }) =>
      _resetCleoPlatformPathsCache(),
    );
    const projectRoot = createProjectWithTasksDb('project-timeout-disabled');

    const result = surveyDbSubstrate(projectRoot, {
      autoQuarantine: false,
      integrityCheckTimeoutMs: 0,
    });
    const tasks = result.projects[0]?.dbs['tasks'];
    if (!tasks) throw new Error('tasks entry absent');

    // Healthy DB w/ timeout disabled: integrityOK true + timedOut false.
    expect(tasks.integrityOK).toBe(true);
    expect(tasks.timedOut).toBe(false);
  });

  // ============================================================================
  // T10323 — cross-DB orphan-row report (Saga T10281 / Epic T10285)
  // ============================================================================

  /**
   * Seed a tasks.db with a single live task and a single live session so
   * the I1/I4/I5 anchor lookups can distinguish present vs. orphan.
   *
   * Schema is the minimum needed by the cross-DB walker — `tasks(id)` and
   * `sessions(id)` columns. Other tasks.db columns are not exercised.
   */
  function seedTasksDbForCrossDb(
    dbPath: string,
    options: { taskIds: string[]; sessionIds: string[] },
  ): void {
    const writer = new DatabaseSyncCtor(dbPath);
    writer.exec(
      `CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT);
       CREATE TABLE sessions (id TEXT PRIMARY KEY, scope TEXT);`,
    );
    const insertTask = writer.prepare('INSERT INTO tasks (id, title) VALUES (?, ?)');
    for (const id of options.taskIds) {
      insertTask.run(id, `title-for-${id}`);
    }
    const insertSession = writer.prepare('INSERT INTO sessions (id, scope) VALUES (?, ?)');
    for (const id of options.sessionIds) {
      insertSession.run(id, 'global');
    }
    writer.close();
  }

  /**
   * Seed a brain.db carrying brain_memory_links rows AND a trio of
   * anchor tables (page_nodes, observations) so I5 anchor resolution
   * can succeed.
   */
  function seedBrainDbForCrossDb(
    dbPath: string,
    options: { linkTaskIds: string[]; pageNodeIds?: string[]; observationIds?: string[] },
  ): void {
    const writer = new DatabaseSyncCtor(dbPath);
    writer.exec(
      `CREATE TABLE brain_memory_links (
         memory_type TEXT NOT NULL,
         memory_id   TEXT NOT NULL,
         task_id     TEXT NOT NULL,
         link_type   TEXT NOT NULL
       );
       CREATE TABLE brain_page_nodes (id TEXT PRIMARY KEY, kind TEXT);
       CREATE TABLE brain_observations (id TEXT PRIMARY KEY, narrative TEXT);`,
    );
    const insertLink = writer.prepare(
      'INSERT INTO brain_memory_links (memory_type, memory_id, task_id, link_type) VALUES (?, ?, ?, ?)',
    );
    for (const taskId of options.linkTaskIds) {
      insertLink.run('observation', `O-mem-${taskId}`, taskId, 'context');
    }
    const insertNode = writer.prepare('INSERT INTO brain_page_nodes (id, kind) VALUES (?, ?)');
    for (const id of options.pageNodeIds ?? []) {
      insertNode.run(id, 'task');
    }
    const insertObs = writer.prepare(
      'INSERT INTO brain_observations (id, narrative) VALUES (?, ?)',
    );
    for (const id of options.observationIds ?? []) {
      insertObs.run(id, 'note');
    }
    writer.close();
  }

  /**
   * Seed a manifest.db (BlobFsAdapter shape) with blob_attachments rows.
   * Only the columns the I2 invariant reads are materialized.
   */
  function seedManifestDbForCrossDb(dbPath: string, docSlugs: string[]): void {
    const writer = new DatabaseSyncCtor(dbPath);
    writer.exec(
      `CREATE TABLE blob_attachments (
         id        TEXT PRIMARY KEY,
         doc_slug  TEXT NOT NULL,
         blob_name TEXT NOT NULL,
         hash      TEXT NOT NULL,
         deleted_at TEXT
       );`,
    );
    const insert = writer.prepare(
      'INSERT INTO blob_attachments (id, doc_slug, blob_name, hash) VALUES (?, ?, ?, ?)',
    );
    let i = 0;
    for (const slug of docSlugs) {
      i += 1;
      insert.run(`atch-${i}`, slug, `blob-${i}.bin`, `${'0'.repeat(63)}${i % 10}`);
    }
    writer.close();
  }

  /**
   * Seed the global cleo.db's nexus_project_registry with the given
   * (projectId, projectPath) pair (T11578 · AC3 prefixed registry table).
   */
  function seedNexusDbForCrossDb(
    dbPath: string,
    rows: { projectId: string; projectPath: string }[],
  ): void {
    const writer = new DatabaseSyncCtor(dbPath);
    writer.exec(
      `CREATE TABLE nexus_project_registry (
         project_id   TEXT PRIMARY KEY,
         project_hash TEXT NOT NULL,
         project_path TEXT NOT NULL,
         name         TEXT NOT NULL
       );`,
    );
    const insert = writer.prepare(
      'INSERT INTO nexus_project_registry (project_id, project_hash, project_path, name) VALUES (?, ?, ?, ?)',
    );
    for (const row of rows) {
      insert.run(row.projectId, row.projectId, row.projectPath, 'fixture');
    }
    writer.close();
  }

  /**
   * Seed an llmtxt.db with a `documents` table that carries a `session_id`
   * column — the schema-aware I4 check probes for ANY table with that
   * column and the test verifies it is found.
   */
  function seedLlmtxtDbForCrossDb(dbPath: string, sessionIds: string[]): void {
    const writer = new DatabaseSyncCtor(dbPath);
    writer.exec(
      `CREATE TABLE documents (
         id         TEXT PRIMARY KEY,
         doc_slug   TEXT NOT NULL,
         session_id TEXT
       );`,
    );
    const insert = writer.prepare(
      'INSERT INTO documents (id, doc_slug, session_id) VALUES (?, ?, ?)',
    );
    let i = 0;
    for (const sessionId of sessionIds) {
      i += 1;
      insert.run(`doc-${i}`, `slug-${i}`, sessionId);
    }
    writer.close();
  }

  /**
   * Seed a conduit.db with a `conduit_dead_letters` table carrying job_id rows
   * (T11578 · AC4 — prefixed table the I5 invariant check now reads).
   */
  function seedConduitDbForCrossDb(dbPath: string, jobIds: string[]): void {
    const writer = new DatabaseSyncCtor(dbPath);
    writer.exec(
      `CREATE TABLE conduit_dead_letters (
         id         TEXT PRIMARY KEY,
         message_id TEXT NOT NULL,
         job_id     TEXT NOT NULL,
         reason     TEXT NOT NULL,
         attempts   INTEGER NOT NULL,
         created_at INTEGER NOT NULL
       );`,
    );
    const insert = writer.prepare(
      'INSERT INTO conduit_dead_letters (id, message_id, job_id, reason, attempts, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    let i = 0;
    for (const jobId of jobIds) {
      i += 1;
      insert.run(`dl-${i}`, `msg-${i}`, jobId, 'max-attempts', 6, Date.now());
    }
    writer.close();
  }

  /**
   * Build a project root with the 6 DBs (tasks, brain, manifest, nexus,
   * llmtxt, conduit) seeded with intentional orphans for every invariant
   * I1..I5. Returns the project root path.
   *
   * Anchor coverage:
   *  - tasks.db lives task T100, session ses_live.
   *  - brain.db link points at orphan T999 (I1 orphan).
   *  - manifest.db doc_slug T888 is an orphan (I2 orphan).
   *  - nexus.db row carries a STALE project_path (I3 orphan).
   *  - llmtxt.db documents.session_id=ses_orphan (I4 orphan).
   *  - conduit.db dead_letters.job_id=J777 (I5 orphan — not in tasks
   *    or brain anchor tables).
   */
  function seedCrossDbFixture(name: string): string {
    const projectRoot = join(fleetRoot, name);
    const cleoDir = join(projectRoot, '.cleo');
    const blobsDir = join(cleoDir, 'blobs');
    const llmtxtDir = join(cleoDir, 'llmtxt');
    mkdirSync(blobsDir, { recursive: true });
    mkdirSync(llmtxtDir, { recursive: true });

    seedTasksDbForCrossDb(join(cleoDir, 'tasks.db'), {
      taskIds: ['T100'],
      sessionIds: ['ses_live'],
    });
    seedBrainDbForCrossDb(join(cleoDir, 'brain.db'), {
      linkTaskIds: ['T100', 'T999'], // T999 is the orphan
      pageNodeIds: ['task:T100'],
      observationIds: ['O-anchor-1'],
    });
    seedManifestDbForCrossDb(join(blobsDir, 'manifest.db'), [
      'T100', // live
      'T888', // orphan
      'cs-changeset-not-a-task', // not T-shaped — skipped by GLOB
    ]);
    // Nexus row uses an INTENTIONAL path mismatch so I3 fires.
    const expectedId = computeSubstrateProjectId(projectRoot);
    const nexusPath = join(cleoHomeOverride, 'nexus.db');
    seedNexusDbForCrossDb(nexusPath, [
      { projectId: expectedId, projectPath: `${projectRoot}-MOVED` },
    ]);
    seedLlmtxtDbForCrossDb(join(llmtxtDir, 'llmtxt.db'), ['ses_live', 'ses_orphan']);
    seedConduitDbForCrossDb(join(cleoDir, 'conduit.db'), [
      'T100', // resolves via tasks
      'task:T100', // resolves via brain_page_nodes
      'O-anchor-1', // resolves via brain_observations
      'J777', // orphan
    ]);
    return projectRoot;
  }

  it('T10323: walkCrossDbInvariants returns one report per invariant in canonical order', async () => {
    await import('@cleocode/paths').then(({ _resetCleoPlatformPathsCache }) =>
      _resetCleoPlatformPathsCache(),
    );
    const projectRoot = createProjectWithTasksDb('cross-db-order');
    const reports = walkCrossDbInvariants(projectRoot);
    expect(reports).toHaveLength(5);
    expect(reports.map((r) => r.invariant)).toEqual(['I1', 'I2', 'I3', 'I4', 'I5']);
    // Every report carries the stable suggestedFix field — even when skipped.
    for (const r of reports) {
      expect(r.suggestedFix.length).toBeGreaterThan(0);
    }
  });

  it('T10323: 3-DB fixture detects orphans across every invariant', async () => {
    await import('@cleocode/paths').then(({ _resetCleoPlatformPathsCache }) =>
      _resetCleoPlatformPathsCache(),
    );
    const projectRoot = seedCrossDbFixture('cross-db-fixture');
    const result = surveyDbSubstrate(projectRoot);

    // Envelope carries crossDbOrphans on the payload.
    expect(result.crossDbOrphans).toBeDefined();
    expect(result.crossDbOrphans.length).toBe(5);

    const byId = new Map(result.crossDbOrphans.map((r) => [r.invariant, r]));

    const i1 = byId.get('I1');
    expect(i1).toBeDefined();
    expect(i1?.skipped).toBe(false);
    expect(i1?.orphanCount).toBeGreaterThanOrEqual(1);
    expect(i1?.sample).toContain('T999');
    expect(i1?.suggestedFix).toContain('cleo memory observe');

    const i2 = byId.get('I2');
    expect(i2?.skipped).toBe(false);
    expect(i2?.orphanCount).toBeGreaterThanOrEqual(1);
    expect(i2?.sample).toContain('T888');
    expect(i2?.suggestedFix).toContain('cleo docs prune');

    const i3 = byId.get('I3');
    expect(i3?.skipped).toBe(false);
    expect(i3?.orphanCount).toBe(1);
    expect(i3?.sample[0]).toContain('-MOVED');
    expect(i3?.suggestedFix).toContain('cleo nexus reset-project-id');

    const i4 = byId.get('I4');
    expect(i4?.skipped).toBe(false);
    expect(i4?.orphanCount).toBe(1);
    expect(i4?.sample).toContain('ses_orphan');
    expect(i4?.suggestedFix).toContain('cleo session start');

    const i5 = byId.get('I5');
    expect(i5?.skipped).toBe(false);
    expect(i5?.orphanCount).toBe(1);
    expect(i5?.sample).toContain('J777');
    expect(i5?.suggestedFix).toMatch(/conduit/i);
  });

  it('T10323: skipped invariants when source/target DBs are absent', async () => {
    await import('@cleocode/paths').then(({ _resetCleoPlatformPathsCache }) =>
      _resetCleoPlatformPathsCache(),
    );
    // Fresh project: only tasks.db exists. brain/manifest/nexus/llmtxt/conduit
    // are all absent — every cross-DB invariant should report skipped.
    const projectRoot = createProjectWithTasksDb('cross-db-skipped');
    const result = surveyDbSubstrate(projectRoot);
    expect(result.crossDbOrphans.length).toBe(5);
    for (const r of result.crossDbOrphans) {
      expect(r.skipped).toBe(true);
      expect(r.orphanCount).toBe(0);
      expect(r.sample).toEqual([]);
      expect(r.skipReason.length).toBeGreaterThan(0);
    }
  });

  it('T10323: I1 reports zero orphans when every brain link anchors a live task', () => {
    const projectRoot = join(fleetRoot, 'i1-clean');
    mkdirSync(join(projectRoot, '.cleo'), { recursive: true });
    seedTasksDbForCrossDb(join(projectRoot, '.cleo', 'tasks.db'), {
      taskIds: ['T1', 'T2'],
      sessionIds: [],
    });
    seedBrainDbForCrossDb(join(projectRoot, '.cleo', 'brain.db'), {
      linkTaskIds: ['T1', 'T2'],
    });

    const reports = walkCrossDbInvariants(projectRoot);
    const i1 = reports.find((r) => r.invariant === 'I1');
    expect(i1?.skipped).toBe(false);
    expect(i1?.orphanCount).toBe(0);
    expect(i1?.sample).toEqual([]);
  });

  it('T10323: I3 returns 0 orphans when nexus project_path matches projectRoot', async () => {
    await import('@cleocode/paths').then(({ _resetCleoPlatformPathsCache }) =>
      _resetCleoPlatformPathsCache(),
    );
    const projectRoot = createProjectWithTasksDb('i3-match');
    const expectedId = computeSubstrateProjectId(projectRoot);
    seedNexusDbForCrossDb(join(cleoHomeOverride, 'nexus.db'), [
      { projectId: expectedId, projectPath: projectRoot },
    ]);

    const reports = walkCrossDbInvariants(projectRoot);
    const i3 = reports.find((r) => r.invariant === 'I3');
    expect(i3?.skipped).toBe(false);
    expect(i3?.orphanCount).toBe(0);
  });

  it('T10323: I4 stays skipped when the llmtxt schema has no session_id column', () => {
    const projectRoot = join(fleetRoot, 'i4-no-column');
    const cleoDir = join(projectRoot, '.cleo');
    const llmtxtDir = join(cleoDir, 'llmtxt');
    mkdirSync(llmtxtDir, { recursive: true });
    seedTasksDbForCrossDb(join(cleoDir, 'tasks.db'), { taskIds: [], sessionIds: [] });

    // Seed an llmtxt.db with a `documents` table that has NO session_id.
    const writer = new DatabaseSyncCtor(join(llmtxtDir, 'llmtxt.db'));
    writer.exec(
      `CREATE TABLE documents (
         id       TEXT PRIMARY KEY,
         doc_slug TEXT NOT NULL
       );`,
    );
    writer.close();

    const reports = walkCrossDbInvariants(projectRoot);
    const i4 = reports.find((r) => r.invariant === 'I4');
    expect(i4?.skipped).toBe(true);
    expect(i4?.skipReason).toMatch(/session_id/);
  });

  it('T10323: orphan reports are bounded — never more than 100 candidate rows scanned', () => {
    const projectRoot = join(fleetRoot, 'i1-bounded');
    mkdirSync(join(projectRoot, '.cleo'), { recursive: true });
    seedTasksDbForCrossDb(join(projectRoot, '.cleo', 'tasks.db'), {
      taskIds: [],
      sessionIds: [],
    });
    // Seed 150 distinct orphan task IDs — well above the 100 LIMIT.
    const ids: string[] = [];
    for (let i = 0; i < 150; i += 1) {
      ids.push(`T-orphan-${i}`);
    }
    seedBrainDbForCrossDb(join(projectRoot, '.cleo', 'brain.db'), { linkTaskIds: ids });

    const reports = walkCrossDbInvariants(projectRoot);
    const i1 = reports.find((r) => r.invariant === 'I1');
    expect(i1?.skipped).toBe(false);
    // Bounded query: at most 100 candidate rows; sample ≤ 5.
    expect(i1?.orphanCount).toBeLessThanOrEqual(100);
    expect((i1?.sample ?? []).length).toBeLessThanOrEqual(5);
  });

  it('T10323: per-invariant checkers can be invoked in isolation (unit-test boundary)', () => {
    // Each exported checker accepts already-open snapshot handles + returns
    // a well-formed report. Smoke test: feeding `null` for every snapshot
    // produces a skipped report with the canonical suggestedFix.
    const i1 = checkInvariantI1(null, null);
    expect(i1.invariant).toBe('I1');
    expect(i1.skipped).toBe(true);
    expect(i1.suggestedFix).toContain('cleo memory observe');

    const i2 = checkInvariantI2(null, null);
    expect(i2.invariant).toBe('I2');
    expect(i2.suggestedFix).toContain('cleo docs prune');

    const i3 = checkInvariantI3('/tmp/no-such-project', null);
    expect(i3.invariant).toBe('I3');
    expect(i3.suggestedFix).toContain('reset-project-id');

    const i4 = checkInvariantI4(null, null);
    expect(i4.invariant).toBe('I4');
    expect(i4.suggestedFix).toMatch(/cleo session start/);

    const i5 = checkInvariantI5(null, null, null);
    expect(i5.invariant).toBe('I5');
    expect(i5.suggestedFix).toMatch(/conduit/i);
  });
});
