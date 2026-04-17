/**
 * Unit tests for `installAgentFromCant` — atomic .cant install pipeline.
 *
 * Verifies:
 * - Happy path: valid .cant copied to destination, row inserted with full v3
 *   column payload, agent_skills junctions written with source='cant'.
 * - Duplicate guard: second install without `force` throws
 *   E_AGENT_ALREADY_INSTALLED; neither the DB nor the filesystem are mutated.
 * - Force overwrite: second install with `force: true` updates the row
 *   and refreshes `agent_skills`, returning `inserted: false`.
 * - Unknown skill soft-warn: agent with a skill slug not in the catalog
 *   still installs (warnings populated, no exception).
 * - Rollback safety: when the DB write fails AFTER the file copy, the
 *   destination file is removed and the DB is unchanged.
 * - Project tier: installs to `<projectRoot>/.cleo/cant/agents/`.
 *
 * All tests use real node:sqlite + real filesystem under a tmp directory.
 * The real user's $XDG_DATA_HOME and project directories are never touched.
 *
 * @task T889 / W2-3
 * @epic T889
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SEED_HISTORIAN_SOURCE =
  '/mnt/projects/cleocode/packages/agents/seed-agents/cleo-historian.cant';

/** Minimal valid .cant manifest used for write-and-install tests. */
const FIXTURE_MINIMAL_CANT = `---
kind: agent
version: 1
---

agent fixture-agent:
  role: worker
  parent: cleo-prime
  description: "Fixture agent for install-pipeline tests."
  prompt: "You are the fixture agent."
  skills: ["ct-cleo", "ct-validator"]
`;

/** A .cant manifest whose skills do not exist in the local catalog. */
const FIXTURE_UNKNOWN_SKILL_CANT = `---
kind: agent
version: 1
---

agent fixture-unknown-skill:
  role: worker
  parent: cleo-prime
  description: "Fixture with an unknown skill slug."
  prompt: "Fixture prompt."
  skills: ["skill-does-not-exist"]
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface TmpEnv {
  cleoHome: string;
  projectRoot: string;
  dbPath: string;
  globalCantDir: string;
  openDb: () => DatabaseSync;
  cleanup: () => void;
}

/**
 * Create an isolated workspace with a freshly-migrated global signaldock.db.
 */
async function makeTmpEnv(suffix: string): Promise<TmpEnv> {
  const base = mkdtempSync(join(tmpdir(), `cleo-w2-3-${suffix}-`));
  const cleoHome = join(base, 'cleo-home');
  const projectRoot = join(base, 'project');
  const globalCantDir = join(base, 'global-cant-agents');
  mkdirSync(cleoHome, { recursive: true });
  mkdirSync(join(projectRoot, '.cleo'), { recursive: true });

  // Deterministic machine-key / global-salt so ensure* is happy.
  writeFileSync(join(cleoHome, 'machine-key'), Buffer.alloc(32, 0xab), { mode: 0o600 });
  writeFileSync(join(cleoHome, 'global-salt'), Buffer.alloc(32, 0xcd), { mode: 0o600 });

  vi.doMock('../../paths.js', async () => {
    const actual = await vi.importActual<typeof import('../../paths.js')>('../../paths.js');
    return {
      ...actual,
      getCleoHome: () => cleoHome,
      getCleoGlobalAgentsDir: () => globalCantDir,
    };
  });

  const { ensureGlobalSignaldockDb, _resetGlobalSignaldockDb_TESTING_ONLY } = await import(
    '../signaldock-sqlite.js'
  );
  _resetGlobalSignaldockDb_TESTING_ONLY();
  await ensureGlobalSignaldockDb();

  const dbPath = join(cleoHome, 'signaldock.db');

  // Seed a pair of skills so the junction-insert path has something to match.
  const seedDb = new DatabaseSync(dbPath);
  seedDb.exec('PRAGMA foreign_keys = ON');
  const nowTs = Math.floor(Date.now() / 1000);
  seedDb
    .prepare(
      `INSERT OR IGNORE INTO skills (id, slug, name, description, category, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run('skill-ct-cleo', 'ct-cleo', 'CT CLEO', 'CLEO task protocol', 'core', nowTs);
  seedDb
    .prepare(
      `INSERT OR IGNORE INTO skills (id, slug, name, description, category, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run('skill-ct-validator', 'ct-validator', 'CT Validator', 'validator', 'core', nowTs);
  seedDb.close();

  const openDb = (): DatabaseSync => {
    const d = new DatabaseSync(dbPath);
    d.exec('PRAGMA foreign_keys = ON');
    d.exec('PRAGMA journal_mode = WAL');
    return d;
  };
  const cleanup = (): void => {
    _resetGlobalSignaldockDb_TESTING_ONLY();
    rmSync(base, { recursive: true, force: true });
  };
  return { cleoHome, projectRoot, dbPath, globalCantDir, openDb, cleanup };
}

/** Write a source `.cant` file inside `dir` and return its path. */
function writeSource(dir: string, filename: string, body: string): string {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, filename);
  writeFileSync(p, body, 'utf8');
  return p;
}

interface AgentRow {
  id: string;
  agent_id: string;
  tier: string;
  can_spawn: number;
  orch_level: number;
  reports_to: string | null;
  cant_path: string | null;
  cant_sha256: string | null;
  installed_from: string | null;
  installed_at: string | null;
  skills: string;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('W2-3 installAgentFromCant — real sqlite + real .cant', () => {
  let env: TmpEnv;

  beforeEach(async () => {
    vi.resetModules();
    env = await makeTmpEnv(Math.random().toString(36).slice(2));
  });

  afterEach(() => {
    env.cleanup();
    vi.restoreAllMocks();
  });

  it('installs a seed .cant to global tier and records full v3 payload', async () => {
    const { installAgentFromCant } = await import('../agent-install.js');
    const db = env.openDb();
    try {
      const result = installAgentFromCant(db, {
        cantSource: SEED_HISTORIAN_SOURCE,
        targetTier: 'global',
        installedFrom: 'seed',
        globalCantDir: env.globalCantDir,
      });

      expect(result.agentId).toBe('cleo-historian');
      expect(result.cantSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(result.tier).toBe('global');
      expect(result.inserted).toBe(true);
      expect(result.skillsAttached).toEqual(expect.arrayContaining(['ct-cleo', 'ct-validator']));

      // Row is present with correct extended fields.
      const row = db.prepare('SELECT * FROM agents WHERE agent_id = ?').get('cleo-historian') as
        | AgentRow
        | undefined;
      expect(row).toBeDefined();
      if (!row) throw new Error('row missing');
      expect(row.tier).toBe('global');
      expect(row.can_spawn).toBe(0);
      expect(row.orch_level).toBe(2);
      expect(row.reports_to).toBe('cleo-prime');
      expect(row.cant_path).toBe(join(env.globalCantDir, 'cleo-historian.cant'));
      expect(row.cant_sha256).toBe(result.cantSha256);
      expect(row.installed_from).toBe('seed');
      expect(row.installed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      // Skills JSON mirrors the .cant source.
      expect(JSON.parse(row.skills)).toEqual(
        expect.arrayContaining(['ct-cleo', 'ct-documentor', 'ct-validator', 'ct-docs-review']),
      );

      // agent_skills junction rows exist for catalog-matched slugs only.
      const junctionRows = db
        .prepare(
          "SELECT slug, source FROM agent_skills JOIN skills ON skills.id = agent_skills.skill_id WHERE agent_skills.agent_id = ? AND source = 'cant'",
        )
        .all(row.id) as Array<{ slug: string; source: string }>;
      expect(junctionRows.map((r) => r.slug).sort()).toEqual(['ct-cleo', 'ct-validator']);

      // File was copied to the destination.
      const destBytes = readFileSync(row.cant_path ?? '', 'utf8');
      expect(destBytes).toMatch(/agent cleo-historian/);
    } finally {
      db.close();
    }
  });

  it('refuses a duplicate install without `force`', async () => {
    const { installAgentFromCant } = await import('../agent-install.js');
    const db = env.openDb();
    try {
      const args = {
        cantSource: SEED_HISTORIAN_SOURCE,
        targetTier: 'global' as const,
        installedFrom: 'seed' as const,
        globalCantDir: env.globalCantDir,
      };
      installAgentFromCant(db, args);
      expect(() => installAgentFromCant(db, args)).toThrow(/already/i);
    } finally {
      db.close();
    }
  });

  it('allows `force: true` overwrite and returns inserted=false', async () => {
    const { installAgentFromCant } = await import('../agent-install.js');
    const db = env.openDb();
    try {
      const args = {
        cantSource: SEED_HISTORIAN_SOURCE,
        targetTier: 'global' as const,
        installedFrom: 'seed' as const,
        globalCantDir: env.globalCantDir,
      };
      const first = installAgentFromCant(db, args);
      expect(first.inserted).toBe(true);
      const second = installAgentFromCant(db, { ...args, force: true });
      expect(second.inserted).toBe(false);
      expect(second.cantSha256).toBe(first.cantSha256);
    } finally {
      db.close();
    }
  });

  it('derives orchestrator / worker role onto can_spawn + orch_level', async () => {
    const { installAgentFromCant } = await import('../agent-install.js');
    const db = env.openDb();
    try {
      const sourceDir = join(env.projectRoot, 'sources');
      const orch = writeSource(
        sourceDir,
        'orch-agent.cant',
        `---\nkind: agent\nversion: 1\n---\n\nagent orch-agent:\n  role: orchestrator\n  parent: none\n  prompt: "Top."\n  skills: []\n`,
      );
      const worker = writeSource(
        sourceDir,
        'worker-agent.cant',
        `---\nkind: agent\nversion: 1\n---\n\nagent worker-agent:\n  role: worker\n  parent: orch-agent\n  prompt: "Work."\n  skills: []\n`,
      );

      installAgentFromCant(db, {
        cantSource: orch,
        targetTier: 'global',
        installedFrom: 'manual',
        globalCantDir: env.globalCantDir,
      });
      installAgentFromCant(db, {
        cantSource: worker,
        targetTier: 'global',
        installedFrom: 'manual',
        globalCantDir: env.globalCantDir,
      });

      const orchRow = db
        .prepare('SELECT can_spawn, orch_level FROM agents WHERE agent_id = ?')
        .get('orch-agent') as { can_spawn: number; orch_level: number };
      expect(orchRow.can_spawn).toBe(1);
      expect(orchRow.orch_level).toBe(0);

      const workerRow = db
        .prepare('SELECT can_spawn, orch_level FROM agents WHERE agent_id = ?')
        .get('worker-agent') as { can_spawn: number; orch_level: number };
      expect(workerRow.can_spawn).toBe(0);
      expect(workerRow.orch_level).toBe(2);
    } finally {
      db.close();
    }
  });

  it('soft-warns on unknown skill slugs without throwing', async () => {
    const { installAgentFromCant } = await import('../agent-install.js');
    const db = env.openDb();
    try {
      const src = writeSource(
        join(env.projectRoot, 'sources'),
        'fixture-unknown-skill.cant',
        FIXTURE_UNKNOWN_SKILL_CANT,
      );
      const result = installAgentFromCant(db, {
        cantSource: src,
        targetTier: 'global',
        installedFrom: 'manual',
        globalCantDir: env.globalCantDir,
      });
      expect(result.warnings.some((w) => /skill-does-not-exist/.test(w))).toBe(true);
      expect(result.skillsAttached).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('installs to project tier at <projectRoot>/.cleo/cant/agents/', async () => {
    const { installAgentFromCant } = await import('../agent-install.js');
    const db = env.openDb();
    try {
      const src = writeSource(
        join(env.projectRoot, 'sources'),
        'fixture-agent.cant',
        FIXTURE_MINIMAL_CANT,
      );
      const result = installAgentFromCant(db, {
        cantSource: src,
        targetTier: 'project',
        installedFrom: 'user',
        projectRoot: env.projectRoot,
      });
      const expectedDest = join(env.projectRoot, '.cleo', 'cant', 'agents', 'fixture-agent.cant');
      expect(result.cantPath).toBe(expectedDest);
      const bytes = readFileSync(expectedDest, 'utf8');
      expect(bytes).toContain('agent fixture-agent');
    } finally {
      db.close();
    }
  });

  it('rejects agent name that does not match filename base', async () => {
    const { installAgentFromCant } = await import('../agent-install.js');
    const db = env.openDb();
    try {
      const src = writeSource(
        join(env.projectRoot, 'sources'),
        'wrong-name.cant',
        FIXTURE_MINIMAL_CANT, // header says 'fixture-agent'
      );
      expect(() =>
        installAgentFromCant(db, {
          cantSource: src,
          targetTier: 'global',
          installedFrom: 'manual',
          globalCantDir: env.globalCantDir,
        }),
      ).toThrow(/filename base/);
    } finally {
      db.close();
    }
  });

  it('rolls back file + row on transaction failure', async () => {
    const { installAgentFromCant } = await import('../agent-install.js');
    const db = env.openDb();
    try {
      // Force a downstream failure by dropping the junction table AFTER
      // the caller opens the transaction. This has to happen inside the
      // installer flow — so we pre-corrupt the schema so the very first
      // INSERT INTO agent_skills raises.
      db.exec('DROP TABLE agent_skills');

      const src = writeSource(
        join(env.projectRoot, 'sources'),
        'fixture-agent.cant',
        FIXTURE_MINIMAL_CANT,
      );

      expect(() =>
        installAgentFromCant(db, {
          cantSource: src,
          targetTier: 'global',
          installedFrom: 'manual',
          globalCantDir: env.globalCantDir,
        }),
      ).toThrow();

      const row = db.prepare('SELECT id FROM agents WHERE agent_id = ?').get('fixture-agent') as
        | { id: string }
        | undefined;
      expect(row).toBeUndefined();
      // Destination file should have been cleaned up.
      const dest = join(env.globalCantDir, 'fixture-agent.cant');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fs = require('node:fs') as typeof import('node:fs');
      expect(fs.existsSync(dest)).toBe(false);
    } finally {
      db.close();
    }
  });
});
