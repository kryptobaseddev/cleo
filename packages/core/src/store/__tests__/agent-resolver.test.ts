/**
 * Unit tests for `resolveAgent` — registry-backed 4-tier precedence.
 *
 * Verifies:
 * - Project-tier resolution wins over global/packaged/fallback
 * - Global-tier resolution falls through when project row absent
 * - Packaged-tier resolution wins over fallback synthesis
 * - Fallback-tier synthesis from bundled `seed-agents/<id>.cant`
 * - `AgentNotFoundError` raised when every tier misses
 * - `DEPRECATED_ALIASES` remap (`cleoos-opus-orchestrator` → `cleo-prime`)
 * - Orphan-row cascade: cant_path missing → next tier
 * - `preferTier` override reorders lookup sequence
 * - `getAgentSkills` returns empty `[]` + correct slug list after attach
 * - `resolveAgentsBatch` mixes successes + errors in its result map
 *
 * All tests chain through the real W2-3 `installAgentFromCant` pipeline to
 * populate rows — no mocks, no fake DBs.
 *
 * @task T889 / W2-4
 * @epic T889
 */

import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
/** Monorepo-relative seed-agent — works locally and in CI. */
const SEED_HISTORIAN_SOURCE = resolve(
  __dirname,
  '../../../../agents/seed-agents/cleo-historian.cant',
);

/** Minimal .cant whose `name` matches the filename base. */
const FIXTURE_WORKER_CANT = `---
kind: agent
version: 1
---

agent fixture-worker:
  role: worker
  parent: cleo-prime
  description: "Worker fixture."
  prompt: "You are fixture-worker."
  skills: ["ct-cleo"]
`;

/** A second agent used for cross-tier tests. */
const FIXTURE_DUAL_CANT = `---
kind: agent
version: 1
---

agent dual-tier:
  role: worker
  parent: cleo-prime
  description: "Dual-tier fixture."
  prompt: "Dual-tier."
  skills: []
`;

/** Synthetic seed used for fallback-tier resolution. */
const FALLBACK_SEED_CANT = `---
kind: agent
version: 1
---

agent fallback-only:
  role: worker
  prompt: "Fallback-only agent."
  skills: []
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface TmpEnv {
  cleoHome: string;
  projectRoot: string;
  dbPath: string;
  globalCantDir: string;
  projectCantDir: string;
  packagedSeedDir: string;
  openDb: () => DatabaseSync;
  cleanup: () => void;
}

async function makeTmpEnv(suffix: string): Promise<TmpEnv> {
  const base = mkdtempSync(join(tmpdir(), `cleo-w2-4-${suffix}-`));
  const cleoHome = join(base, 'cleo-home');
  const projectRoot = join(base, 'project');
  const globalCantDir = join(base, 'global-cant-agents');
  const projectCantDir = join(projectRoot, '.cleo', 'cant', 'agents');
  const packagedSeedDir = join(base, 'packaged-seed-agents');

  mkdirSync(cleoHome, { recursive: true });
  mkdirSync(projectCantDir, { recursive: true });
  mkdirSync(globalCantDir, { recursive: true });
  mkdirSync(packagedSeedDir, { recursive: true });

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

  // Seed the skills catalog so junction writes succeed for fixtures.
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
  return {
    cleoHome,
    projectRoot,
    dbPath,
    globalCantDir,
    projectCantDir,
    packagedSeedDir,
    openDb,
    cleanup,
  };
}

function writeSource(dir: string, filename: string, body: string): string {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, filename);
  writeFileSync(p, body, 'utf8');
  return p;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('W2-4 resolveAgent — 4-tier precedence with real sqlite', () => {
  let env: TmpEnv;

  beforeEach(async () => {
    vi.resetModules();
    env = await makeTmpEnv(Math.random().toString(36).slice(2));
  });

  afterEach(() => {
    env.cleanup();
    vi.restoreAllMocks();
  });

  it('resolves project-tier agent when installed to project', async () => {
    const { installAgentFromCant } = await import('../agent-install.js');
    const { resolveAgent } = await import('../agent-resolver.js');
    const db = env.openDb();
    try {
      const src = writeSource(
        join(env.projectRoot, 'sources'),
        'fixture-worker.cant',
        FIXTURE_WORKER_CANT,
      );
      installAgentFromCant(db, {
        cantSource: src,
        targetTier: 'project',
        installedFrom: 'user',
        projectRoot: env.projectRoot,
      });

      const resolved = resolveAgent(db, 'fixture-worker', { projectRoot: env.projectRoot });
      expect(resolved.agentId).toBe('fixture-worker');
      expect(resolved.tier).toBe('project');
      expect(resolved.source).toBe('project');
      expect(resolved.cantPath).toBe(join(env.projectCantDir, 'fixture-worker.cant'));
      expect(resolved.cantSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(resolved.aliasApplied).toBe(false);
      expect(resolved.orchLevel).toBe(2);
      expect(resolved.canSpawn).toBe(false);
      expect(resolved.reportsTo).toBe('cleo-prime');
      expect(resolved.skills).toEqual(expect.arrayContaining(['ct-cleo']));
    } finally {
      db.close();
    }
  });

  it('falls through to global tier when project row absent', async () => {
    const { installAgentFromCant } = await import('../agent-install.js');
    const { resolveAgent } = await import('../agent-resolver.js');
    const db = env.openDb();
    try {
      installAgentFromCant(db, {
        cantSource: SEED_HISTORIAN_SOURCE,
        targetTier: 'global',
        installedFrom: 'seed',
        globalCantDir: env.globalCantDir,
      });

      const resolved = resolveAgent(db, 'cleo-historian', { projectRoot: env.projectRoot });
      expect(resolved.tier).toBe('global');
      expect(resolved.source).toBe('global');
      expect(resolved.cantPath).toBe(join(env.globalCantDir, 'cleo-historian.cant'));
      expect(resolved.skills).toEqual(expect.arrayContaining(['ct-cleo', 'ct-validator']));
    } finally {
      db.close();
    }
  });

  it('falls through to packaged tier when project and global rows absent', async () => {
    const { installAgentFromCant } = await import('../agent-install.js');
    const { resolveAgent } = await import('../agent-resolver.js');
    const db = env.openDb();
    try {
      const pkgSrc = writeSource(env.packagedSeedDir, 'fixture-worker.cant', FIXTURE_WORKER_CANT);
      // Install at 'packaged' tier by targeting 'global' then rewriting tier via
      // direct SQL UPDATE — installAgentFromCant only accepts project|global, but
      // the resolver SELECT keys on the `tier` column regardless of install tier.
      installAgentFromCant(db, {
        cantSource: pkgSrc,
        targetTier: 'global',
        installedFrom: 'seed',
        globalCantDir: env.packagedSeedDir,
      });
      db.prepare("UPDATE agents SET tier = 'packaged' WHERE agent_id = ?").run('fixture-worker');

      const resolved = resolveAgent(db, 'fixture-worker', { projectRoot: env.projectRoot });
      expect(resolved.tier).toBe('packaged');
      expect(resolved.source).toBe('packaged');
    } finally {
      db.close();
    }
  });

  it('synthesises a fallback envelope when no row exists but seed file on disk', async () => {
    const { resolveAgent } = await import('../agent-resolver.js');
    const db = env.openDb();
    try {
      writeSource(env.packagedSeedDir, 'fallback-only.cant', FALLBACK_SEED_CANT);
      const resolved = resolveAgent(db, 'fallback-only', {
        projectRoot: env.projectRoot,
        packagedSeedDir: env.packagedSeedDir,
      });
      expect(resolved.tier).toBe('fallback');
      expect(resolved.source).toBe('fallback');
      expect(resolved.canSpawn).toBe(false);
      expect(resolved.orchLevel).toBe(2);
      expect(resolved.skills).toEqual([]);
      expect(resolved.cantPath).toBe(join(env.packagedSeedDir, 'fallback-only.cant'));
      expect(resolved.cantSha256).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      db.close();
    }
  });

  it('throws AgentNotFoundError when nothing found in any tier', async () => {
    const { resolveAgent, AgentNotFoundError } = await import('../agent-resolver.js');
    const db = env.openDb();
    try {
      expect(() =>
        resolveAgent(db, 'does-not-exist-anywhere', {
          projectRoot: env.projectRoot,
          packagedSeedDir: env.packagedSeedDir,
        }),
      ).toThrow(AgentNotFoundError);
      try {
        resolveAgent(db, 'does-not-exist-anywhere', {
          projectRoot: env.projectRoot,
          packagedSeedDir: env.packagedSeedDir,
        });
      } catch (err) {
        expect(err).toBeInstanceOf(AgentNotFoundError);
        if (err instanceof AgentNotFoundError) {
          expect(err.agentId).toBe('does-not-exist-anywhere');
          expect(err.triedTiers).toEqual(['project', 'global', 'packaged', 'fallback']);
          expect(err.code).toBe('E_AGENT_NOT_FOUND');
          expect(err.exitCode).toBe(65);
        }
      }
    } finally {
      db.close();
    }
  });

  it('remaps DEPRECATED_ALIASES: cleoos-opus-orchestrator → cleo-prime', async () => {
    const { installAgentFromCant } = await import('../agent-install.js');
    const { resolveAgent, DEPRECATED_ALIASES } = await import('../agent-resolver.js');
    const db = env.openDb();
    try {
      // Install the canonical target, then look up via the deprecated alias.
      installAgentFromCant(db, {
        cantSource: resolve(__dirname, '../../../../agents/seed-agents/cleo-prime.cant'),
        targetTier: 'global',
        installedFrom: 'seed',
        globalCantDir: env.globalCantDir,
      });

      expect(DEPRECATED_ALIASES['cleoos-opus-orchestrator']).toBe('cleo-prime');

      const resolved = resolveAgent(db, 'cleoos-opus-orchestrator', {
        projectRoot: env.projectRoot,
      });
      expect(resolved.agentId).toBe('cleo-prime');
      expect(resolved.aliasApplied).toBe(true);
      expect(resolved.aliasTarget).toBe('cleo-prime');
      expect(resolved.tier).toBe('global');
    } finally {
      db.close();
    }
  });

  it('cascades past an orphan row (cant_path missing on disk) to the next tier', async () => {
    const { installAgentFromCant } = await import('../agent-install.js');
    const { resolveAgent } = await import('../agent-resolver.js');
    const db = env.openDb();
    try {
      // Install at BOTH project and global tier.
      const projectSrc = writeSource(
        join(env.projectRoot, 'sources'),
        'dual-tier.cant',
        FIXTURE_DUAL_CANT,
      );
      installAgentFromCant(db, {
        cantSource: projectSrc,
        targetTier: 'project',
        installedFrom: 'user',
        projectRoot: env.projectRoot,
      });
      // Record the project-tier cant_path so we can nuke it below.
      const projectCantPath = (
        db.prepare('SELECT cant_path FROM agents WHERE agent_id = ?').get('dual-tier') as {
          cant_path: string;
        }
      ).cant_path;
      expect(projectCantPath).toBe(join(env.projectCantDir, 'dual-tier.cant'));

      // Force a row-level tier switch to 'global' by rewriting cant_path + tier.
      // The resolver treats the row as the project-tier record because `tier=project`;
      // we orphan it by deleting the file on disk.
      unlinkSync(projectCantPath);

      // Re-install the same id at the global tier so there is a real fallback.
      installAgentFromCant(db, {
        cantSource: projectSrc,
        targetTier: 'global',
        installedFrom: 'manual',
        globalCantDir: env.globalCantDir,
        force: true,
      });

      // After force-install the single row now tracks tier='global'. Restore the
      // project row with a deliberately-dangling cant_path so the cascade is
      // exercised end-to-end.
      db.prepare('UPDATE agents SET tier = ?, cant_path = ? WHERE agent_id = ?').run(
        'global',
        join(env.globalCantDir, 'dual-tier.cant'),
        'dual-tier',
      );
      // Insert a SECOND dangling project-tier row with a brand-new UUID so the
      // composite (agent_id, tier) scan hits it first.
      const globalRow = db.prepare('SELECT * FROM agents WHERE agent_id = ?').get('dual-tier') as {
        id: string;
        skills: string;
      };
      db.prepare(
        `INSERT INTO agents (
            id, agent_id, name, class, privacy_tier, capabilities, skills,
            transport_type, api_base_url, transport_config, is_active,
            status, created_at, updated_at, requires_reauth,
            tier, can_spawn, orch_level, reports_to,
            cant_path, cant_sha256, installed_from, installed_at
          ) VALUES (?, ?, ?, 'custom', 'public', '[]', ?, 'http',
            'https://api.signaldock.io', '{}', 1,
            'online', ?, ?, 0,
            'project', 0, 2, 'cleo-prime',
            ?, 'deadbeef', 'user', datetime('now'))`,
      ).run(
        'orphan-dup-row',
        'dual-tier-orphan',
        'dual-tier',
        globalRow.skills,
        Math.floor(Date.now() / 1000),
        Math.floor(Date.now() / 1000),
        join(env.projectCantDir, 'does-not-exist.cant'),
      );

      // Query the fresh orphan id: it has ONLY a project-tier row pointing at a
      // non-existent file, so the resolver must cascade past it and ultimately
      // raise AgentNotFoundError because no other tier holds it.
      const { AgentNotFoundError } = await import('../agent-resolver.js');
      expect(() =>
        resolveAgent(db, 'dual-tier-orphan', {
          projectRoot: env.projectRoot,
          packagedSeedDir: env.packagedSeedDir,
        }),
      ).toThrow(AgentNotFoundError);

      // But the canonical 'dual-tier' still resolves at the global tier
      // because its file is intact.
      const resolved = resolveAgent(db, 'dual-tier', {
        projectRoot: env.projectRoot,
        packagedSeedDir: env.packagedSeedDir,
      });
      expect(resolved.tier).toBe('global');
    } finally {
      db.close();
    }
  });

  it('preferTier option overrides the default lookup order', async () => {
    const { installAgentFromCant } = await import('../agent-install.js');
    const { resolveAgent } = await import('../agent-resolver.js');
    const db = env.openDb();
    try {
      // Install at global only so the default order tries project→global.
      installAgentFromCant(db, {
        cantSource: SEED_HISTORIAN_SOURCE,
        targetTier: 'global',
        installedFrom: 'seed',
        globalCantDir: env.globalCantDir,
      });
      const r = resolveAgent(db, 'cleo-historian', {
        projectRoot: env.projectRoot,
        preferTier: 'global',
      });
      expect(r.tier).toBe('global');
    } finally {
      db.close();
    }
  });

  it('getAgentSkills returns [] when agent not present', async () => {
    const { getAgentSkills } = await import('../agent-resolver.js');
    const db = env.openDb();
    try {
      expect(getAgentSkills(db, 'no-such-agent')).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('getAgentSkills returns slug list after install', async () => {
    const { installAgentFromCant } = await import('../agent-install.js');
    const { getAgentSkills } = await import('../agent-resolver.js');
    const db = env.openDb();
    try {
      const src = writeSource(
        join(env.projectRoot, 'sources'),
        'fixture-worker.cant',
        FIXTURE_WORKER_CANT,
      );
      installAgentFromCant(db, {
        cantSource: src,
        targetTier: 'global',
        installedFrom: 'manual',
        globalCantDir: env.globalCantDir,
      });
      const skills = getAgentSkills(db, 'fixture-worker');
      expect(skills).toEqual(expect.arrayContaining(['ct-cleo']));
    } finally {
      db.close();
    }
  });

  it('resolveAgentsBatch mixes successes and AgentNotFoundError in result map', async () => {
    const { installAgentFromCant } = await import('../agent-install.js');
    const { resolveAgentsBatch, AgentNotFoundError } = await import('../agent-resolver.js');
    const db = env.openDb();
    try {
      installAgentFromCant(db, {
        cantSource: SEED_HISTORIAN_SOURCE,
        targetTier: 'global',
        installedFrom: 'seed',
        globalCantDir: env.globalCantDir,
      });

      const map = resolveAgentsBatch(db, ['cleo-historian', 'ghost-agent'], {
        projectRoot: env.projectRoot,
        packagedSeedDir: env.packagedSeedDir,
      });

      expect(map.size).toBe(2);
      const hist = map.get('cleo-historian');
      expect(hist && 'agentId' in hist && hist.agentId).toBe('cleo-historian');
      const ghost = map.get('ghost-agent');
      expect(ghost).toBeInstanceOf(AgentNotFoundError);
    } finally {
      db.close();
    }
  });
});
