/**
 * Round-trip tests for the portable (manifest v2) bundle.
 *
 * Every fixture lives in a temp directory; no real project, CLEO home or
 * config home is touched (homes are passed explicitly, never via ambient env).
 *
 * @task T12318
 * @epic T12317
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync as _DatabaseSyncType } from 'node:sqlite';
import type { PortableBundleManifest } from '@cleocode/contracts';
import { create as tarCreate, extract as tarExtract, list as tarList } from 'tar';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateProjectHash } from '../../nexus/hash.js';
import {
  computeManifestHash,
  exportPortableBundle,
  isTempProjectPath,
  PortableBundleError,
} from '../portable-bundle.js';
import { importPortableBundle } from '../portable-bundle-import.js';

const _require = createRequire(import.meta.url);
type DatabaseSync = _DatabaseSyncType;
const { DatabaseSync } = _require('node:sqlite') as {
  DatabaseSync: new (...args: ConstructorParameters<typeof _DatabaseSyncType>) => DatabaseSync;
};

const PROJECT_ID = 'proj-0000-1111';

/** Create a project-scope cleo.db with the prefixed tables export counts. */
function seedProjectDb(dbPath: string, root: string): void {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE tasks_tasks (id TEXT PRIMARY KEY, title TEXT);
    CREATE TABLE brain_observations (id TEXT PRIMARY KEY, narrative TEXT);
    CREATE TABLE attachments (id TEXT PRIMARY KEY, attachment_json TEXT);
    CREATE TABLE tasks_sessions (id TEXT PRIMARY KEY, owner_auth_token TEXT);
    INSERT INTO tasks_sessions VALUES ('S1', 'OWNER-TOKEN-SECRET-9f3a'), ('S2', NULL);
  `);
  const ins = db.prepare('INSERT INTO tasks_tasks VALUES (?, ?)');
  for (let i = 0; i < 25; i++) ins.run(`T${i}`, `task ${i}`);
  db.prepare('INSERT INTO brain_observations VALUES (?, ?)').run(
    'O1',
    `edited ${root}/src/app.ts by hand`,
  );
  db.prepare('INSERT INTO attachments VALUES (?, ?)').run(
    'A1',
    JSON.stringify({ kind: 'local-file', path: `${root}/docs/spec.md` }),
  );
  db.prepare('INSERT INTO attachments VALUES (?, ?)').run(
    'A2',
    JSON.stringify({ kind: 'local-file', path: '/elsewhere/outside.md' }),
  );
  db.close();
}

/** Create a project root with a live store, content, secrets and excluded dirs. */
function seedProject(root: string, name = 'demo'): void {
  const cleo = path.join(root, '.cleo');
  fs.mkdirSync(path.join(cleo, 'agent-outputs'), { recursive: true });
  fs.mkdirSync(path.join(cleo, 'keys'), { recursive: true });
  fs.mkdirSync(path.join(cleo, 'backups', 'sqlite'), { recursive: true });
  seedProjectDb(path.join(cleo, 'cleo.db'), root);
  // legacy pre-E6 file still on disk
  const legacy = new DatabaseSync(path.join(cleo, 'tasks.db'));
  legacy.exec('CREATE TABLE tasks (id TEXT); INSERT INTO tasks VALUES (1);');
  legacy.close();
  fs.writeFileSync(
    path.join(cleo, 'project-info.json'),
    JSON.stringify({ projectId: PROJECT_ID, projectHash: generateProjectHash(root), name }),
  );
  fs.writeFileSync(path.join(cleo, 'config.json'), JSON.stringify({ worktreeRoot: `${root}/wt` }));
  fs.writeFileSync(path.join(cleo, 'agent-outputs', 'note.md'), `see ${root}/README.md\n`);
  fs.writeFileSync(path.join(cleo, 'keys', 'cleo-identity.json'), '{"secret":"x"}');
  fs.writeFileSync(path.join(cleo, 'backups', 'sqlite', 'old.db'), Buffer.alloc(4096));
  fs.symlinkSync('agent-outputs/note.md', path.join(cleo, 'latest-note.md'));
  // outside-root file must never be bundled
  fs.writeFileSync(path.join(root, '.env.local'), 'SECRET=do-not-bundle');
}

/** Create a global home with a registry row for `projectRoot`. */
function seedGlobalHome(home: string, projectRoot: string): void {
  fs.mkdirSync(path.join(home, 'worktrees', 'abc'), { recursive: true });
  fs.writeFileSync(path.join(home, 'worktrees', 'abc', 'big.bin'), Buffer.alloc(2048));
  const db = new DatabaseSync(path.join(home, 'cleo.db'));
  db.exec(`CREATE TABLE nexus_project_registry (
    project_id TEXT PRIMARY KEY, project_hash TEXT NOT NULL, project_path TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL, last_seen TEXT, brain_db_path TEXT, tasks_db_path TEXT)`);
  db.prepare('INSERT INTO nexus_project_registry VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    PROJECT_ID,
    generateProjectHash(projectRoot),
    projectRoot,
    'demo',
    'x',
    `${projectRoot}/.cleo/brain.db`,
    `${projectRoot}/.cleo/tasks.db`,
  );
  db.close();
  const g = new DatabaseSync(path.join(home, 'cleo.db'));
  g.exec(`CREATE TABLE agent_registry_agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, api_key_encrypted TEXT NOT NULL);
    INSERT INTO agent_registry_agents VALUES ('a1', 'worker', 'AGENT-KEY-SECRET-77b1');`);
  g.close();
  fs.writeFileSync(path.join(home, 'global-salt'), crypto.randomBytes(32));
  fs.writeFileSync(path.join(home, 'device-id'), 'dev-1');
  fs.writeFileSync(path.join(home, 'machine-key'), crypto.randomBytes(32));
}

async function archiveEntries(bundle: string): Promise<string[]> {
  const entries: string[] = [];
  await tarList({ file: bundle, onReadEntry: (e) => entries.push(e.path) });
  return entries;
}

describe('portable bundle v2 (T12318)', () => {
  let tmp: string;
  let projectRoot: string;
  let home: string;
  let configHome: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cleo-t12318-'));
    projectRoot = path.join(tmp, 'src-root', 'demo');
    home = path.join(tmp, 'home');
    configHome = path.join(tmp, 'config');
    fs.mkdirSync(projectRoot, { recursive: true });
    seedProject(projectRoot);
    seedGlobalHome(home, projectRoot);
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('project scope captures the live cleo.db and round-trips losslessly into a new root', async () => {
    const bundle = path.join(tmp, 'out', 'p.cleobundle.tar.gz');
    const exported = await exportPortableBundle({
      scope: 'project',
      projectRoot,
      outputPath: bundle,
      label: 'p',
      cleoHome: home,
      configHome,
    });
    const section = exported.sections[0];
    expect(section?.keyCounts).toMatchObject({ tasks_tasks: 25, brain_observations: 1 });
    expect(section?.excluded.map((e) => e.relPath)).toContain('backups');
    expect(section?.excluded.find((e) => e.relPath === 'backups')?.bytes).toBe(4096);
    expect(section?.requiresReentry).toEqual([
      expect.objectContaining({
        relPath: 'cleo.db',
        table: 'tasks_sessions',
        columns: ['owner_auth_token'],
        rows: 1,
      }),
      expect.objectContaining({ relPath: 'keys/cleo-identity.json' }),
    ]);
    expect(exported.secretsIncluded).toBe(false);
    // ADR-093: memories always travel, and the result says they are unprotected.
    expect(exported.memory).toMatchObject({
      included: true,
      encrypted: false,
      counts: { brain_observations: 1 },
    });
    expect(exported.memory.notice).toContain('PLAIN TEXT');

    const entries = await archiveEntries(bundle);
    expect(entries[0]).toBe('manifest.json');
    expect(entries.some((e) => e.endsWith('/cleo/cleo.db'))).toBe(true);
    expect(entries.some((e) => e.includes('keys/'))).toBe(false);
    expect(entries.some((e) => e.includes('.env'))).toBe(false);
    expect(entries.some((e) => e.includes('backups/'))).toBe(false);

    const target = path.join(tmp, 'dest-root', 'moved');
    const imported = await importPortableBundle({
      bundlePath: bundle,
      target,
      cleoHome: path.join(tmp, 'home-dest'),
      configHome: path.join(tmp, 'config-dest'),
    });
    expect(imported.lossless).toBe(true);
    const proj = imported.sections[0];
    expect(proj?.mismatches).toEqual([]);
    expect(proj?.hashMismatches).toEqual([]);
    expect(proj?.hashesCompared).toBe(2); // agent-outputs/note.md + tasks.db
    expect(proj?.hashSkipped.sort()).toEqual(['cleo.db', 'config.json', 'project-info.json']);
    expect(proj?.keyCounts.find((k) => k.table === 'tasks_tasks')).toEqual({
      table: 'tasks_tasks',
      expected: 25,
      actual: 25,
    });

    // structural path rewritten; historical narrative left and reported
    const db = new DatabaseSync(path.join(target, '.cleo', 'cleo.db'), { readOnly: true });
    const a1 = db.prepare("SELECT attachment_json AS j FROM attachments WHERE id='A1'").get() as {
      j: string;
    };
    const o1 = db.prepare("SELECT narrative AS n FROM brain_observations WHERE id='O1'").get() as {
      n: string;
    };
    db.close();
    expect(JSON.parse(a1.j).path).toBe(`${target}/docs/spec.md`);
    // credential cleared, row kept
    const sess = new DatabaseSync(path.join(target, '.cleo', 'cleo.db'), { readOnly: true });
    const tokens = sess
      .prepare('SELECT id, owner_auth_token AS t FROM tasks_sessions ORDER BY id')
      .all() as Array<{ id: string; t: string | null }>;
    sess.close();
    expect(tokens).toEqual([
      { id: 'S1', t: null },
      { id: 'S2', t: null },
    ]);
    expect(o1.n).toContain(projectRoot);
    const reloc = proj?.relocation;
    expect(reloc?.leftUnderOldRoot.map((f) => f.location)).toContain(
      'cleo.db:brain_observations.narrative',
    );
    expect(reloc?.leftOutsideRoot.map((f) => f.example)).toContain('/elsewhere/outside.md');
    // docs/spec.md was never restored at the new root, so the rewrite is flagged
    expect(reloc?.rewrittenTargetMissing.map((f) => f.example)).toEqual([`${target}/docs/spec.md`]);

    const info = JSON.parse(
      fs.readFileSync(path.join(target, '.cleo', 'project-info.json'), 'utf-8'),
    ) as { projectId: string; projectHash: string };
    expect(info.projectId).toBe(PROJECT_ID);
    expect(info.projectHash).toBe(generateProjectHash(target));
    const config = JSON.parse(
      fs.readFileSync(path.join(target, '.cleo', 'config.json'), 'utf-8'),
    ) as { worktreeRoot: string };
    expect(config.worktreeRoot).toBe(`${target}/wt`);
    expect(fs.readlinkSync(path.join(target, '.cleo', 'latest-note.md'))).toBe(
      'agent-outputs/note.md',
    );
    expect(fs.existsSync(path.join(target, '.cleo', 'tasks.db'))).toBe(true);
    expect(fs.existsSync(path.join(target, '.cleo', 'keys'))).toBe(false);
  });

  it('fails loudly when neither the primary store nor a legacy store exists', async () => {
    fs.rmSync(path.join(projectRoot, '.cleo', 'cleo.db'));
    fs.rmSync(path.join(projectRoot, '.cleo', 'tasks.db'));
    const err = await exportPortableBundle({
      scope: 'project',
      projectRoot,
      outputPath: path.join(tmp, 'out', 'x.cleobundle.tar.gz'),
      label: 'x',
      cleoHome: home,
      configHome,
    }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(PortableBundleError);
    expect((err as PortableBundleError).code).toBe('E_PRIMARY_STORE_MISSING');
    expect(fs.existsSync(path.join(tmp, 'out', 'x.cleobundle.tar.gz'))).toBe(false);
  });

  it('preserves and reports data that exists only in legacy stores', async () => {
    // Empty-shell cleo.db (the measured 2026-08-12 case) beside a populated legacy tasks.db.
    const cleo = path.join(projectRoot, '.cleo');
    const shell = new DatabaseSync(path.join(cleo, 'cleo.db'));
    shell.exec(
      'DELETE FROM tasks_tasks; CREATE TABLE tasks (id INTEGER); INSERT INTO tasks VALUES (1), (2);',
    );
    shell.close();
    const legacy = new DatabaseSync(path.join(cleo, 'tasks.db'));
    legacy.exec('INSERT INTO tasks VALUES (2), (3);');
    legacy.close();
    const brain = new DatabaseSync(path.join(cleo, 'brain.db'));
    brain.exec(
      'CREATE TABLE brain_observations (id TEXT); INSERT INTO brain_observations VALUES (1),(2),(3);',
    );
    brain.close();

    const bundle = path.join(tmp, 'out', 'legacy.cleobundle.tar.gz');
    const exported = await exportPortableBundle({
      scope: 'project',
      projectRoot,
      outputPath: bundle,
      label: 'legacy',
      cleoHome: home,
      configHome,
    });
    expect(exported.sections[0]?.unmigratedLegacyData).toEqual({
      detected: true,
      evidence: [
        {
          database: 'brain.db',
          table: 'brain_observations',
          legacyRows: 3,
          primaryTable: 'brain_observations',
          primaryRows: 1,
        },
        {
          database: 'tasks.db',
          table: 'tasks',
          legacyRows: 3,
          primaryTable: 'tasks_tasks',
          primaryRows: 0,
          primaryUnprefixedRows: 2,
        },
      ],
    });
    let registerCalls = 0;
    const imported = await importPortableBundle({
      bundlePath: bundle,
      target: path.join(tmp, 'legacy-dest'),
      cleoHome: path.join(tmp, 'home-dest'),
      registerProject: async () => {
        registerCalls += 1;
        return { status: 'registered', detail: 'should not be called' };
      },
    });
    expect(registerCalls).toBe(0);
    expect(imported.sections[0]?.registry?.status).toBe('skipped');
    expect(imported.lossless).toBe(true);
    expect(imported.sections[0]?.unmigratedLegacyData?.detected).toBe(true);
    const restored = new DatabaseSync(path.join(tmp, 'legacy-dest', '.cleo', 'tasks.db'), {
      readOnly: true,
    });
    const n = restored.prepare('SELECT COUNT(*) AS c FROM tasks').get() as { c: number };
    restored.close();
    expect(n.c).toBe(3);

    // No cleo.db at all: the legacy stores alone are exported, not a failure.
    fs.rmSync(path.join(cleo, 'cleo.db'));
    const onlyLegacy = await exportPortableBundle({
      scope: 'project',
      projectRoot,
      outputPath: path.join(tmp, 'out', 'only-legacy.cleobundle.tar.gz'),
      label: 'only-legacy',
      cleoHome: home,
      configHome,
    });
    expect(onlyLegacy.sections[0]?.unmigratedLegacyData?.detected).toBe(true);
  });

  it('refuses to overwrite live data without force', async () => {
    const bundle = path.join(tmp, 'out', 'p.cleobundle.tar.gz');
    await exportPortableBundle({
      scope: 'project',
      projectRoot,
      outputPath: bundle,
      label: 'p',
      cleoHome: home,
      configHome,
    });
    const err = await importPortableBundle({
      bundlePath: bundle,
      target: projectRoot,
      cleoHome: path.join(tmp, 'home-dest'),
    }).catch((e: Error) => e);
    expect((err as PortableBundleError).code).toBe('E_DATA_EXISTS');
  });

  it('machine scope re-registers moved projects via --map (even without a projectId in project-info)', async () => {
    // Many real projects predate project-info.projectId; the registry row must still move.
    const infoPath = path.join(projectRoot, '.cleo', 'project-info.json');
    fs.writeFileSync(infoPath, JSON.stringify({ name: 'demo' }));
    const bundle = path.join(tmp, 'out', 'm.cleobundle.tar.gz');
    const exported = await exportPortableBundle({
      scope: 'machine',
      outputPath: bundle,
      label: 'm',
      cleoHome: home,
      configHome,
      isTempPath: (p) => p.includes('fixture-temp'),
    });
    expect(exported.machine).toEqual({ registered: 1, included: 1, skippedByReason: {} });
    expect(exported.sections.find((s) => s.kind === 'global-home')?.excluded).toContainEqual(
      expect.objectContaining({ relPath: 'worktrees', bytes: 2048 }),
    );

    const newPrefix = path.join(tmp, 'new-machine');
    const destHome = path.join(tmp, 'home-dest');
    const imported = await importPortableBundle({
      bundlePath: bundle,
      maps: [{ from: path.join(tmp, 'src-root'), to: newPrefix }],
      cleoHome: destHome,
      configHome: path.join(tmp, 'config-dest'),
    });
    expect(imported.lossless).toBe(true);
    const proj = imported.sections.find((s) => s.kind === 'project');
    expect(proj?.destinationRoot).toBe(path.join(newPrefix, 'demo'));
    expect(proj?.registry?.status).toBe('updated');
    expect(proj?.projectId).toBe(PROJECT_ID);

    const db = new DatabaseSync(path.join(destHome, 'cleo.db'), { readOnly: true });
    const row = db
      .prepare('SELECT project_path AS p, project_hash AS h FROM nexus_project_registry')
      .get() as { p: string; h: string };
    db.close();
    expect(row.p).toBe(path.join(newPrefix, 'demo'));
    expect(row.h).toBe(generateProjectHash(path.join(newPrefix, 'demo')));
    expect(
      imported.requiresReentry.map((s) => `${s.relPath}${s.table ? `#${s.table}` : ''}`).sort(),
    ).toEqual([
      'cleo.db#agent_registry_agents',
      'cleo.db#tasks_sessions',
      'global-salt',
      'keys/cleo-identity.json',
    ]);
    expect(fs.existsSync(path.join(destHome, 'global-salt'))).toBe(false);
    expect(fs.existsSync(path.join(destHome, 'worktrees'))).toBe(false);
  });

  it('encrypted bundles carry secrets and reject a wrong passphrase', async () => {
    const bundle = path.join(tmp, 'out', 'g.enc.cleobundle.tar.gz');
    const exported = await exportPortableBundle({
      scope: 'global',
      outputPath: bundle,
      label: 'g',
      encrypt: true,
      passphrase: 'correct horse',
      cleoHome: home,
      configHome,
    });
    expect(exported.secretsIncluded).toBe(true);
    const wrong = await importPortableBundle({
      bundlePath: bundle,
      passphrase: 'wrong',
      cleoHome: path.join(tmp, 'home-dest'),
    }).catch((e: Error) => e);
    expect((wrong as PortableBundleError).code).toBe('E_BUNDLE_DECRYPT');
    expect(fs.existsSync(path.join(tmp, 'home-dest', 'cleo.db'))).toBe(false);

    const ok = await importPortableBundle({
      bundlePath: bundle,
      passphrase: 'correct horse',
      cleoHome: path.join(tmp, 'home-dest'),
      configHome: path.join(tmp, 'config-dest'),
    });
    expect(ok.lossless).toBe(true);
    expect(ok.requiresReentry).toEqual([]);
    // machine-key is device-bound: never exported, not even encrypted (T12326).
    expect(fs.existsSync(path.join(tmp, 'home-dest', 'machine-key'))).toBe(false);
    expect(
      exported.sections.find((s) => s.kind === 'global-home')?.excluded.map((e) => e.relPath),
    ).toContain('machine-key');
    const agents = new DatabaseSync(path.join(tmp, 'home-dest', 'cleo.db'), { readOnly: true });
    const key = agents
      .prepare('SELECT api_key_encrypted AS k FROM agent_registry_agents')
      .get() as {
      k: string;
    };
    agents.close();
    expect(key.k).toBe('AGENT-KEY-SECRET-77b1');
    expect(fs.readFileSync(path.join(tmp, 'home-dest', 'global-salt'))).toEqual(
      fs.readFileSync(path.join(home, 'global-salt')),
    );
  });

  it('detects a row-count mismatch and a tampered manifest', async () => {
    const bundle = path.join(tmp, 'out', 'p.cleobundle.tar.gz');
    await exportPortableBundle({
      scope: 'project',
      projectRoot,
      outputPath: bundle,
      label: 'p',
      cleoHome: home,
      configHome,
    });
    const unpacked = path.join(tmp, 'unpacked');
    fs.mkdirSync(unpacked);
    await tarExtract({ file: bundle, cwd: unpacked });
    const manifestPath = path.join(unpacked, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as PortableBundleManifest;
    const primary = manifest.projects[0]?.databases.find((d) => d.role === 'primary');
    if (!primary) throw new Error('fixture has no primary store');
    primary.rowCounts['tasks_tasks'] = 26;
    const repack = async (name: string): Promise<string> => {
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
      const out = path.join(tmp, 'out', name);
      const files = fs.readdirSync(unpacked, { recursive: true, withFileTypes: true });
      await tarCreate({ gzip: true, file: out, cwd: unpacked }, [
        'manifest.json',
        ...files
          .filter((f) => f.isFile() && f.name !== 'manifest.json')
          .map((f) => path.relative(unpacked, path.join(f.parentPath, f.name))),
      ]);
      return out;
    };

    // Tampered without re-hashing: rejected before anything is placed.
    const tampered = await repack('tampered.cleobundle.tar.gz');
    const err = await importPortableBundle({
      bundlePath: tampered,
      target: path.join(tmp, 'dest-a'),
      cleoHome: path.join(tmp, 'home-dest'),
    }).catch((e: Error) => e);
    expect((err as PortableBundleError).code).toBe('E_BUNDLE_INTEGRITY');
    expect(fs.existsSync(path.join(tmp, 'dest-a'))).toBe(false);

    // Consistently re-hashed: placed, then the re-count exposes the mismatch.
    manifest.integrity.manifestHash = computeManifestHash(manifest);
    const rehashed = await repack('rehashed.cleobundle.tar.gz');
    const result = await importPortableBundle({
      bundlePath: rehashed,
      target: path.join(tmp, 'dest-b'),
      cleoHome: path.join(tmp, 'home-dest'),
    });
    expect(result.lossless).toBe(false);
    expect(result.sections[0]?.mismatches).toEqual([
      { database: 'cleo.db', table: 'tasks_tasks', expected: 26, actual: 25 },
    ]);
  });

  it('an unencrypted bundle carries no credential bytes, only a requiresReentry list', async () => {
    const bundle = path.join(tmp, 'out', 'plain.cleobundle.tar.gz');
    const exported = await exportPortableBundle({
      scope: 'all',
      projectRoot,
      outputPath: bundle,
      label: 'plain',
      cleoHome: home,
      configHome,
    });
    const reentry = exported.sections.flatMap((s) => s.requiresReentry);
    expect(reentry).toContainEqual(
      expect.objectContaining({
        relPath: 'cleo.db',
        table: 'agent_registry_agents',
        columns: ['api_key_encrypted'],
        rows: 1,
      }),
    );
    const unpacked = path.join(tmp, 'plain-unpacked');
    fs.mkdirSync(unpacked);
    await tarExtract({ file: bundle, cwd: unpacked });
    const everything = fs
      .readdirSync(unpacked, { recursive: true, withFileTypes: true })
      .filter((f) => f.isFile())
      .map((f) => fs.readFileSync(path.join(f.parentPath, f.name)).toString('latin1'))
      .join('');
    expect(everything).not.toContain('AGENT-KEY-SECRET-77b1');
    expect(everything).not.toContain('OWNER-TOKEN-SECRET-9f3a');
    expect(everything).toContain('edited'); // memory text is present in plain text (ADR-093)
  });

  it('classifies temp and fixture paths', () => {
    expect(isTempProjectPath(path.join(os.tmpdir(), 'x'))).toBe(true);
    expect(isTempProjectPath(path.join(os.homedir(), '.temp', 'y'))).toBe(true);
    expect(isTempProjectPath('/srv/code/vitest-run-1/project')).toBe(true);
    expect(isTempProjectPath('/srv/code/real-project')).toBe(false);
  });
});
