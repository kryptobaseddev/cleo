/**
 * Unit tests for `buildDoctorReport` + `reconcileDoctor` — the `.cant` /
 * registry reconciliation walker introduced by T889 / T901 / W2-7.
 *
 * Each test case seeds an isolated tmp tree with its own global
 * signaldock.db, materializes a drift scenario, and asserts that the
 * expected D-code surfaces with the expected severity / fix command.
 *
 * All tests use the real node:sqlite runtime and the real filesystem
 * under a mkdtemp-ed root — the user's `$XDG_DATA_HOME` and project
 * directories are never touched.
 *
 * @task T889 / T901 / W2-7
 * @epic T889
 */

import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXTURE_MINIMAL_CANT = `---
kind: agent
version: 1
---

agent doctor-fixture:
  role: worker
  parent: cleo-prime
  description: "Fixture agent for doctor tests."
  prompt: "Fixture prompt."
  skills: ["ct-cleo"]
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface TmpEnv {
  cleoHome: string;
  projectRoot: string;
  dbPath: string;
  globalCantDir: string;
  homeDir: string;
  openDb: () => DatabaseSync;
  cleanup: () => void;
}

/**
 * Create an isolated workspace with a freshly-migrated global signaldock.db.
 *
 * @param suffix - Unique suffix so parallel tests do not collide.
 * @returns A `TmpEnv` whose `cleanup` tears down the tmp tree and resets
 *   the test-only db-path cache.
 */
async function makeTmpEnv(suffix: string): Promise<TmpEnv> {
  const base = mkdtempSync(join(tmpdir(), `cleo-w2-7-${suffix}-`));
  const cleoHome = join(base, 'cleo-home');
  const projectRoot = join(base, 'project');
  const globalCantDir = join(base, 'global-cant-agents');
  const homeDir = join(base, 'home');
  mkdirSync(cleoHome, { recursive: true });
  mkdirSync(join(projectRoot, '.cleo'), { recursive: true });
  mkdirSync(homeDir, { recursive: true });

  // Deterministic machine-key / global-salt so ensure* is happy.
  writeFileSync(join(cleoHome, 'machine-key'), Buffer.alloc(32, 0xab), { mode: 0o600 });
  writeFileSync(join(cleoHome, 'global-salt'), Buffer.alloc(32, 0xcd), { mode: 0o600 });

  vi.doMock('../../paths.js', async () => {
    const actual = await vi.importActual<typeof import('../../paths.js')>('../../paths.js');
    return {
      ...actual,
      getCleoHome: () => cleoHome,
      getCleoGlobalAgentsDir: () => globalCantDir,
      getCleoGlobalCantAgentsDir: () => globalCantDir,
      getCleoLegacyGlobalAgentsDir: () => join(cleoHome, 'agents'),
    };
  });

  const { ensureGlobalAgentRegistryDb, _resetGlobalAgentRegistryDb_TESTING_ONLY } = await import(
    '../agent-registry-store.js'
  );
  _resetGlobalAgentRegistryDb_TESTING_ONLY();
  await ensureGlobalAgentRegistryDb();

  const dbPath = join(cleoHome, 'cleo.db'); // E6-L5 (T11525): signaldock consolidated into GLOBAL cleo.db

  // Seed the catalog so junction-row assertions have something to match.
  const seedDb = new DatabaseSync(dbPath);
  seedDb.exec('PRAGMA foreign_keys = ON');
  const nowIso = new Date().toISOString();
  seedDb
    .prepare(
      `INSERT OR IGNORE INTO agent_registry_skills (id, slug, name, description, category, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run('skill-ct-cleo', 'ct-cleo', 'CT CLEO', 'CLEO task protocol', 'core', nowIso);
  seedDb.close();

  const openDb = (): DatabaseSync => {
    const d = new DatabaseSync(dbPath);
    d.exec('PRAGMA foreign_keys = ON');
    d.exec('PRAGMA journal_mode = WAL');
    return d;
  };
  const cleanup = (): void => {
    _resetGlobalAgentRegistryDb_TESTING_ONLY();
    rmSync(base, { recursive: true, force: true });
  };
  return { cleoHome, projectRoot, dbPath, globalCantDir, homeDir, openDb, cleanup };
}

/** Write a .cant source into the supplied dir, creating parents as needed. */
function writeCant(dir: string, filename: string, body: string): string {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, filename);
  writeFileSync(p, body, 'utf8');
  return p;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('W2-7 buildDoctorReport + reconcileDoctor — real sqlite + real .cant', () => {
  let env: TmpEnv;

  beforeEach(async () => {
    vi.resetModules();
    env = await makeTmpEnv(Math.random().toString(36).slice(2));
  });

  afterEach(() => {
    env.cleanup();
    vi.restoreAllMocks();
  });

  it('emits D-001 for an orphan .cant file in the global tier', async () => {
    const { buildDoctorReport } = await import('../agent-doctor.js');
    writeCant(env.globalCantDir, 'doctor-fixture.cant', FIXTURE_MINIMAL_CANT);
    const db = env.openDb();
    try {
      const report = await buildDoctorReport(db, {
        globalCantDir: env.globalCantDir,
        homeDir: env.homeDir,
      });
      const d001 = report.findings.filter((f) => f.code === 'D-001');
      expect(d001).toHaveLength(1);
      expect(d001[0]?.severity).toBe('warn');
      expect(d001[0]?.subject).toBe('global:doctor-fixture');
      expect(d001[0]?.fixCommand).toMatch(/cleo agent install .* --global/);
      expect(report.summary.warn).toBeGreaterThanOrEqual(1);
    } finally {
      db.close();
    }
  });

  it('emits D-002 for a row pointing at a non-existent path', async () => {
    const { buildDoctorReport } = await import('../agent-doctor.js');
    const db = env.openDb();
    try {
      const nowIso = new Date().toISOString();
      db.prepare(
        `INSERT INTO agent_registry_agents (
          id, agent_id, name, class, privacy_tier, capabilities, skills,
          transport_type, api_base_url, transport_config, is_active,
          status, created_at, updated_at, requires_reauth,
          tier, can_spawn, orch_level, cant_path, cant_sha256, installed_from, installed_at
        ) VALUES (?, ?, ?, 'custom', 'public', '[]', '[]', 'http',
          'https://api.signaldock.io', '{}', 1,
          'online', ?, ?, 0,
          'global', 0, 2, ?, ?, 'manual', ?)`,
      ).run(
        'uuid-orphan',
        'orphan-row',
        'orphan-row',
        nowIso,
        nowIso,
        '/tmp/definitely-does-not-exist/missing.cant',
        'a'.repeat(64),
        nowIso,
      );

      const report = await buildDoctorReport(db, {
        globalCantDir: env.globalCantDir,
        homeDir: env.homeDir,
      });
      const d002 = report.findings.filter((f) => f.code === 'D-002');
      expect(d002).toHaveLength(1);
      expect(d002[0]?.severity).toBe('error');
      expect(d002[0]?.subject).toBe('global:orphan-row');
      expect(d002[0]?.fixCommand).toContain('cleo agent remove orphan-row');
      expect(report.summary.error).toBeGreaterThanOrEqual(1);
    } finally {
      db.close();
    }
  });

  it('emits D-003 when the on-disk file has drifted from the stored sha256', async () => {
    const { installAgentFromCant } = await import('../agent-install.js');
    const { buildDoctorReport } = await import('../agent-doctor.js');
    const sourcePath = writeCant(
      join(env.projectRoot, 'sources'),
      'doctor-fixture.cant',
      FIXTURE_MINIMAL_CANT,
    );
    const db = env.openDb();
    try {
      const install = installAgentFromCant(db, {
        cantSource: sourcePath,
        targetTier: 'global',
        installedFrom: 'manual',
        globalCantDir: env.globalCantDir,
      });
      expect(install.inserted).toBe(true);

      // Modify the destination file so the hash drifts.
      appendFileSync(install.cantPath, '\n# drift marker added by test\n');

      const report = await buildDoctorReport(db, {
        globalCantDir: env.globalCantDir,
        homeDir: env.homeDir,
      });
      const d003 = report.findings.filter((f) => f.code === 'D-003');
      expect(d003).toHaveLength(1);
      expect(d003[0]?.severity).toBe('error');
      expect(d003[0]?.subject).toBe('global:doctor-fixture');
      expect(d003[0]?.fixCommand).toContain('--force');
    } finally {
      db.close();
    }
  });

  // T14600: agents installed to the legacy <cleoHome>/agents dir still get the
  // filesystem drift checks, and each finding names the file it is about.
  it('runs D-001 and D-003 on the legacy <cleoHome>/agents dir and names the file', async () => {
    const { installAgentFromCant } = await import('../agent-install.js');
    const { buildDoctorReport } = await import('../agent-doctor.js');
    const legacyDir = join(env.cleoHome, 'agents');
    const orphan = writeCant(legacyDir, 'legacy-orphan.cant', FIXTURE_MINIMAL_CANT);
    const sourcePath = writeCant(
      join(env.projectRoot, 'sources'),
      'doctor-fixture.cant',
      FIXTURE_MINIMAL_CANT,
    );
    const db = env.openDb();
    try {
      // An install made by an older CLEO: file and row in the legacy dir.
      const install = installAgentFromCant(db, {
        cantSource: sourcePath,
        targetTier: 'global',
        installedFrom: 'manual',
        globalCantDir: legacyDir,
      });
      appendFileSync(install.cantPath, '\n# drift marker added by test\n');

      const report = await buildDoctorReport(db, {
        globalCantDir: env.globalCantDir,
        homeDir: env.homeDir,
      });
      const d001 = report.findings.filter((f) => f.code === 'D-001');
      expect(d001).toHaveLength(1);
      expect(d001[0]?.subject).toBe('global:legacy-orphan');
      expect(d001[0]?.message).toContain(orphan);
      const d003 = report.findings.filter((f) => f.code === 'D-003');
      expect(d003).toHaveLength(1);
      expect(d003[0]?.subject).toBe('global:doctor-fixture');
      expect(d003[0]?.message).toContain(join(legacyDir, 'doctor-fixture.cant'));
    } finally {
      db.close();
    }
  });

  // T14600: after an upgrade and reinstall, a stale legacy copy must not be
  // drift-checked or offered for install over the registered canonical file.
  it('reports a stale legacy copy of a canonical agent as D-011 with no fix command', async () => {
    const { installAgentFromCant } = await import('../agent-install.js');
    const { buildDoctorReport } = await import('../agent-doctor.js');
    const legacyDir = join(env.cleoHome, 'agents');
    const sourcePath = writeCant(
      join(env.projectRoot, 'sources'),
      'doctor-fixture.cant',
      FIXTURE_MINIMAL_CANT,
    );
    // Stale copy: different bytes and skills from the registered file.
    const stale = writeCant(
      legacyDir,
      'doctor-fixture.cant',
      `${FIXTURE_MINIMAL_CANT.replace('["ct-cleo"]', '[]')}\n# stale\n`,
    );
    const db = env.openDb();
    try {
      const install = installAgentFromCant(db, {
        cantSource: sourcePath,
        targetTier: 'global',
        installedFrom: 'manual',
        globalCantDir: env.globalCantDir,
      });

      const report = await buildDoctorReport(db, {
        globalCantDir: env.globalCantDir,
        homeDir: env.homeDir,
      });
      const codes = report.findings.map((f) => f.code);
      expect(codes).not.toContain('D-003');
      expect(codes).not.toContain('D-005');
      expect(codes).not.toContain('D-006');
      const d011 = report.findings.filter((f) => f.code === 'D-011');
      expect(d011).toHaveLength(1);
      expect(d011[0]?.severity).toBe('info');
      expect(d011[0]?.subject).toBe('global:doctor-fixture');
      expect(d011[0]?.message).toContain(stale);
      expect(d011[0]?.message).toContain(install.cantPath);
      expect(report.findings.some((f) => f.fixCommand?.includes(stale))).toBe(false);
    } finally {
      db.close();
    }
  });

  it('emits D-010 when ~/.cleo/agent-registry.json is present', async () => {
    const { buildDoctorReport } = await import('../agent-doctor.js');
    const legacyDir = join(env.homeDir, '.cleo');
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, 'agent-registry.json'), '{"agents":[]}', 'utf8');

    const db = env.openDb();
    try {
      const report = await buildDoctorReport(db, {
        globalCantDir: env.globalCantDir,
        homeDir: env.homeDir,
      });
      const d010 = report.findings.filter((f) => f.code === 'D-010');
      expect(d010).toHaveLength(1);
      expect(d010[0]?.severity).toBe('info');
      expect(d010[0]?.subject).toBe('legacy-json-registry');
      expect(d010[0]?.fixCommand).toContain('--import-legacy-json');
    } finally {
      db.close();
    }
  });

  it('reconcileDoctor deletes the row that backs a D-002 finding', async () => {
    const { buildDoctorReport, reconcileDoctor } = await import('../agent-doctor.js');
    const db = env.openDb();
    try {
      const nowIso = new Date().toISOString();
      db.prepare(
        `INSERT INTO agent_registry_agents (
          id, agent_id, name, class, privacy_tier, capabilities, skills,
          transport_type, api_base_url, transport_config, is_active,
          status, created_at, updated_at, requires_reauth,
          tier, can_spawn, orch_level, cant_path, cant_sha256, installed_from, installed_at
        ) VALUES (?, ?, ?, 'custom', 'public', '[]', '[]', 'http',
          'https://api.signaldock.io', '{}', 1,
          'online', ?, ?, 0,
          'global', 0, 2, ?, ?, 'manual', ?)`,
      ).run(
        'uuid-orphan-2',
        'orphan-row-2',
        'orphan-row-2',
        nowIso,
        nowIso,
        '/tmp/definitely-does-not-exist/also-missing.cant',
        'b'.repeat(64),
        nowIso,
      );

      const report = await buildDoctorReport(db, {
        globalCantDir: env.globalCantDir,
        homeDir: env.homeDir,
      });
      const result = await reconcileDoctor(db, report.findings);
      expect(result.repaired).toContain('D-002');

      const remaining = db
        .prepare('SELECT id FROM agent_registry_agents WHERE agent_id = ?')
        .get('orphan-row-2') as { id: string } | undefined;
      expect(remaining).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it('emits an empty report when the registry and filesystem are in sync', async () => {
    const { installAgentFromCant } = await import('../agent-install.js');
    const { buildDoctorReport } = await import('../agent-doctor.js');
    const sourcePath = writeCant(
      join(env.projectRoot, 'sources'),
      'doctor-fixture.cant',
      FIXTURE_MINIMAL_CANT,
    );
    const db = env.openDb();
    try {
      installAgentFromCant(db, {
        cantSource: sourcePath,
        targetTier: 'global',
        installedFrom: 'manual',
        globalCantDir: env.globalCantDir,
      });

      const report = await buildDoctorReport(db, {
        globalCantDir: env.globalCantDir,
        homeDir: env.homeDir,
      });
      expect(report.findings).toHaveLength(0);
      expect(report.summary).toEqual({ error: 0, warn: 0, info: 0 });
      expect(report.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    } finally {
      db.close();
    }
  });
  // T14654: a seed installed before the CANT syntax change never parses. The
  // doctor refreshes it from the packaged template only when it is unedited.
  describe('D-007 unparseable seed', () => {
    const OLD_SEED = `${FIXTURE_MINIMAL_CANT}  context_sources:\n    - source: patterns\n      query: "x"\n`;
    const NEW_TEMPLATE = FIXTURE_MINIMAL_CANT.replace('Fixture prompt.', 'Refreshed prompt.');
    /** Stand-in for the CLI's real parser: the old YAML-list form does not parse. */
    const cantParses = async (p: string): Promise<boolean> =>
      !readFileSync(p, 'utf8').includes('- source:');

    async function installOldSeed(db: DatabaseSync): Promise<{ cantPath: string; tpl: string }> {
      const { installAgentFromCant } = await import('../agent-install.js');
      const src = writeCant(join(env.projectRoot, 'old'), 'doctor-fixture.cant', OLD_SEED);
      const tpl = join(env.projectRoot, 'templates');
      writeCant(tpl, 'doctor-fixture.cant', NEW_TEMPLATE);
      const { cantPath } = installAgentFromCant(db, {
        cantSource: src,
        targetTier: 'project',
        installedFrom: 'seed',
        projectRoot: env.projectRoot,
      });
      return { cantPath, tpl };
    }

    it('refreshes an unedited seed from the packaged template on repair', async () => {
      const { buildDoctorReport, reconcileDoctor } = await import('../agent-doctor.js');
      const db = env.openDb();
      try {
        const { cantPath, tpl } = await installOldSeed(db);
        const opts = {
          projectRoot: env.projectRoot,
          globalCantDir: env.globalCantDir,
          homeDir: env.homeDir,
          templatesDir: tpl,
          cantParses,
        };
        const report = await buildDoctorReport(db, opts);
        const d007 = report.findings.filter((f) => f.code === 'D-007');
        expect(d007).toHaveLength(1);
        expect(d007[0]?.subject).toBe('project:doctor-fixture');
        expect(d007[0]?.fixCommand).toBe('cleo agent doctor --repair');

        const result = await reconcileDoctor(db, d007, { templatesDir: tpl });
        expect(result.repaired).toEqual(['D-007']);
        expect(readFileSync(cantPath, 'utf8')).toBe(NEW_TEMPLATE);
        const after = await buildDoctorReport(db, opts);
        expect(after.findings).toHaveLength(0);
      } finally {
        db.close();
      }
    });

    it('reports an edited unparseable seed with a fix and leaves it alone', async () => {
      const { buildDoctorReport, reconcileDoctor } = await import('../agent-doctor.js');
      const db = env.openDb();
      try {
        const { cantPath, tpl } = await installOldSeed(db);
        appendFileSync(cantPath, '# user edit\n');
        const edited = readFileSync(cantPath, 'utf8');
        const report = await buildDoctorReport(db, {
          projectRoot: env.projectRoot,
          globalCantDir: env.globalCantDir,
          homeDir: env.homeDir,
          templatesDir: tpl,
          cantParses,
        });
        const d007 = report.findings.filter((f) => f.code === 'D-007');
        expect(d007).toHaveLength(1);
        expect(d007[0]?.message).toContain('edited after install');
        expect(d007[0]?.fixCommand).toBe(`cleo agent install ${cantPath} --force`);

        const result = await reconcileDoctor(db, d007, { templatesDir: tpl });
        expect(result.skipped).toEqual(['D-007']);
        expect(readFileSync(cantPath, 'utf8')).toBe(edited);
      } finally {
        db.close();
      }
    });
  });
});
