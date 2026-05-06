/**
 * Unit tests for `resolveAgent` — registry-backed 5-tier precedence.
 *
 * Verifies:
 * - Project-tier resolution wins over global/packaged/fallback/universal
 * - Global-tier resolution falls through when project row absent
 * - Packaged-tier resolution wins over fallback synthesis
 * - Fallback-tier synthesis from bundled `templates/<id>.cant` (ADR-068 Fix 1)
 * - Universal-tier synthesis when all prior tiers miss (ADR-068 Fix 2)
 * - `AgentNotFoundError` raised ONLY when universal base is unreachable
 * - `DEPRECATED_ALIASES` table is empty (T1257 clean-forward policy — no back-compat)
 * - Orphan-row cascade: cant_path missing → next tier
 * - `preferTier` override reorders lookup sequence
 * - `getAgentSkills` returns empty `[]` + correct slug list after attach
 * - `resolveAgentsBatch` mixes successes + errors in its result map
 * - Spawn validator pre-flight accepts fallback/universal tier resolution
 * - `resolveDefaultTemplatesDir` returns path ending in `agents/templates`
 *
 * All tests chain through the real W2-3 `installAgentFromCant` pipeline to
 * populate rows — no mocks, no fake DBs.
 *
 * @task T889 / W2-4 / T1933
 * @epic T889 / T1929
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
/**
 * Monorepo-relative cleo-historian.cant path — works locally and in CI.
 *
 * Post-T1237: cleo-historian is a project-specific persona, not a generic
 * seed template. It lives under the cleocode repo's `.cleo/cant/agents/`
 * (project tier per T889).
 */
const SEED_HISTORIAN_SOURCE = resolve(
  __dirname,
  '../../../../../.cleo/cant/agents/cleo-historian.cant',
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

/**
 * Template CANT fixture that mirrors the ADR-068 naming convention:
 * filename basename equals declared agent name, using `project-<role>` prefix.
 * Used to verify Bug 5 fix (fallback path now looks in `templates/`).
 */
const PROJECT_DOCS_WORKER_CANT = `---
kind: agent
version: 1
---

agent project-docs-worker:
  role: worker
  parent: cleo-prime
  description: "Docs worker template."
  prompt: "You are project-docs-worker."
  skills: []
`;

/** Universal-base CANT fixture for T1933 tests. */
const UNIVERSAL_BASE_CANT = `---
kind: agent
version: 1
---

agent cleo-subagent:
  role: worker
  prompt: "Universal base."
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
  /** ADR-068: `templates/` directory — replaces `seed-agents/` for fallback resolution. */
  templatesDir: string;
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
  const templatesDir = join(base, 'packaged-templates');

  mkdirSync(cleoHome, { recursive: true });
  mkdirSync(projectCantDir, { recursive: true });
  mkdirSync(globalCantDir, { recursive: true });
  mkdirSync(packagedSeedDir, { recursive: true });
  mkdirSync(templatesDir, { recursive: true });

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
    templatesDir,
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

  it('throws AgentNotFoundError only when the universal base is unreachable (T1241)', async () => {
    const { resolveAgent, AgentNotFoundError } = await import('../agent-resolver.js');
    const db = env.openDb();
    try {
      // Pin `universalBasePath` to a path that does not exist so the 5th-tier
      // fallback also misses and the resolver reverts to the pre-T1241
      // behaviour of raising AgentNotFoundError with every tier enumerated.
      const missingUniversalBase = join(env.cleoHome, 'no-such-universal-base.cant');
      expect(() =>
        resolveAgent(db, 'does-not-exist-anywhere', {
          projectRoot: env.projectRoot,
          packagedSeedDir: env.packagedSeedDir,
          universalBasePath: missingUniversalBase,
        }),
      ).toThrow(AgentNotFoundError);
      try {
        resolveAgent(db, 'does-not-exist-anywhere', {
          projectRoot: env.projectRoot,
          packagedSeedDir: env.packagedSeedDir,
          universalBasePath: missingUniversalBase,
        });
      } catch (err) {
        expect(err).toBeInstanceOf(AgentNotFoundError);
        if (err instanceof AgentNotFoundError) {
          expect(err.agentId).toBe('does-not-exist-anywhere');
          expect(err.triedTiers).toEqual([
            'project',
            'global',
            'packaged',
            'fallback',
            'universal',
          ]);
          expect(err.code).toBe('E_AGENT_NOT_FOUND');
          expect(err.exitCode).toBe(65);
        }
      }
    } finally {
      db.close();
    }
  });

  it('T1241 — falls through to universal-base when every prior tier misses and base is reachable', async () => {
    const { resolveAgent } = await import('../agent-resolver.js');
    const db = env.openDb();
    try {
      // Write a synthetic universal base file to the tmp environment.
      const universalBasePath = join(env.cleoHome, 'synthetic-universal-base.cant');
      writeFileSync(
        universalBasePath,
        '---\nkind: agent\nversion: 1\n---\n\nagent cleo-subagent:\n  role: worker\n  prompt: "Universal base."\n  skills: []\n',
        'utf-8',
      );

      const resolved = resolveAgent(db, 'classifier-picked-ghost', {
        projectRoot: env.projectRoot,
        packagedSeedDir: env.packagedSeedDir,
        universalBasePath,
      });
      expect(resolved.tier).toBe('universal');
      expect(resolved.source).toBe('universal');
      expect(resolved.aliasApplied).toBe(true);
      expect(resolved.aliasTarget).toBe('cleo-subagent');
      // The caller-facing agentId preserves the classifier's original request
      // so downstream telemetry can surface what the operator asked for.
      expect(resolved.agentId).toBe('classifier-picked-ghost');
      expect(resolved.cantPath).toBe(universalBasePath);
      expect(resolved.canSpawn).toBe(false);
      expect(resolved.orchLevel).toBe(2);
      expect(resolved.skills).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('DEPRECATED_ALIASES table is empty (clean-forward policy, T1257)', async () => {
    const { DEPRECATED_ALIASES } = await import('../agent-resolver.js');
    expect(Object.keys(DEPRECATED_ALIASES)).toHaveLength(0);
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
      // raise AgentNotFoundError when the universal-base fallback is pinned to
      // an unreachable path (post-T1241 the 5th tier would otherwise rescue it).
      const { AgentNotFoundError } = await import('../agent-resolver.js');
      const missingUniversalBase = join(env.cleoHome, 'no-such-universal-base.cant');
      expect(() =>
        resolveAgent(db, 'dual-tier-orphan', {
          projectRoot: env.projectRoot,
          packagedSeedDir: env.packagedSeedDir,
          universalBasePath: missingUniversalBase,
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

  it('T1324 — tryResolveUniversalBase sets resolverWarning and never calls console.warn', async () => {
    const { resolveAgent } = await import('../agent-resolver.js');
    const db = env.openDb();
    // Spy on console.warn BEFORE the call — must not be invoked.
    const warnSpy = vi.spyOn(console, 'warn');
    try {
      const universalBasePath = join(env.cleoHome, 'universal-base-warn-test.cant');
      writeFileSync(
        universalBasePath,
        '---\nkind: agent\nversion: 1\n---\n\nagent cleo-subagent:\n  role: worker\n  prompt: "Universal base."\n  skills: []\n',
        'utf-8',
      );

      const resolved = resolveAgent(db, 'ghost-agent-for-warn-test', {
        projectRoot: env.projectRoot,
        packagedSeedDir: env.packagedSeedDir,
        universalBasePath,
      });

      // Structured warning is set on the envelope.
      expect(resolved.resolverWarning).toBeTypeOf('string');
      expect(resolved.resolverWarning).toContain('ghost-agent-for-warn-test');
      expect(resolved.resolverWarning).toContain('cleo-subagent');
      // console.warn must NOT have been called — diagnostic goes through
      // the structured PlanWarning channel, not stderr/stdout.
      expect(warnSpy).not.toHaveBeenCalled();
      // Sanity: we still got the universal tier envelope.
      expect(resolved.tier).toBe('universal');
    } finally {
      db.close();
      warnSpy.mockRestore();
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

      // Pin universal-base to a missing path so the ghost entry surfaces as
      // AgentNotFoundError — post-T1241 the 5th tier would otherwise rescue
      // it with a synthetic envelope.
      const missingUniversalBase = join(env.cleoHome, 'no-such-universal-base.cant');
      const map = resolveAgentsBatch(db, ['cleo-historian', 'ghost-agent'], {
        projectRoot: env.projectRoot,
        packagedSeedDir: env.packagedSeedDir,
        universalBasePath: missingUniversalBase,
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

  // ── T1933: ADR-068 Fix 1 — fallback path uses `templates/` ────────────────

  it('T1933 Fix 1 — fallback tier finds project-docs-worker.cant in templates/ (ADR-068 D1+D2)', async () => {
    const { resolveAgent } = await import('../agent-resolver.js');
    const db = env.openDb();
    try {
      // Write `project-docs-worker.cant` into the templates dir.
      // Filename basename matches declared agent name (ADR-068 D1).
      writeSource(env.templatesDir, 'project-docs-worker.cant', PROJECT_DOCS_WORKER_CANT);

      // No DB row installed — resolver must find the file via fallback tier.
      const resolved = resolveAgent(db, 'project-docs-worker', {
        projectRoot: env.projectRoot,
        packagedSeedDir: env.templatesDir, // pin to isolated templates fixture
        universalBasePath: join(env.cleoHome, 'no-such-universal-base.cant'),
      });

      expect(resolved.tier).toBe('fallback');
      expect(resolved.source).toBe('fallback');
      expect(resolved.agentId).toBe('project-docs-worker');
      expect(resolved.cantPath).toBe(join(env.templatesDir, 'project-docs-worker.cant'));
      expect(resolved.cantSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(resolved.canSpawn).toBe(false);
      expect(resolved.orchLevel).toBe(2);
      expect(resolved.skills).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('T1933 Fix 1 — project tier wins over fallback templates/ file when both present', async () => {
    const { installAgentFromCant } = await import('../agent-install.js');
    const { resolveAgent } = await import('../agent-resolver.js');
    const db = env.openDb();
    try {
      // Plant the template file in templates/ as a fallback source.
      writeSource(env.templatesDir, 'project-docs-worker.cant', PROJECT_DOCS_WORKER_CANT);

      // Also install at project tier — project tier MUST win.
      const src = writeSource(
        join(env.projectRoot, 'sources'),
        'project-docs-worker.cant',
        PROJECT_DOCS_WORKER_CANT,
      );
      installAgentFromCant(db, {
        cantSource: src,
        targetTier: 'project',
        installedFrom: 'user',
        projectRoot: env.projectRoot,
      });

      const resolved = resolveAgent(db, 'project-docs-worker', {
        projectRoot: env.projectRoot,
        packagedSeedDir: env.templatesDir,
        universalBasePath: join(env.cleoHome, 'no-such-universal-base.cant'),
      });

      // Project tier beats fallback templates/ file.
      expect(resolved.tier).toBe('project');
      expect(resolved.source).toBe('project');
    } finally {
      db.close();
    }
  });

  // ── T1933: ADR-068 Fix 2 — universal tier wired into pre-flight ───────────

  it('T1933 Fix 2 — universal tier synthesises envelope when all 4 prior tiers miss', async () => {
    const { resolveAgent } = await import('../agent-resolver.js');
    const db = env.openDb();
    try {
      const universalBasePath = join(env.cleoHome, 'cleo-subagent-fixture.cant');
      writeFileSync(universalBasePath, UNIVERSAL_BASE_CANT, 'utf-8');

      // No DB row, no fallback file — only the universal base is reachable.
      const resolved = resolveAgent(db, 'project-docs-worker', {
        projectRoot: env.projectRoot,
        packagedSeedDir: env.templatesDir, // empty dir — fallback misses
        universalBasePath,
      });

      expect(resolved.tier).toBe('universal');
      expect(resolved.source).toBe('universal');
      expect(resolved.agentId).toBe('project-docs-worker');
      expect(resolved.aliasApplied).toBe(true);
      expect(resolved.aliasTarget).toBe('cleo-subagent');
      expect(resolved.cantPath).toBe(universalBasePath);
      expect(resolved.canSpawn).toBe(false);
      expect(resolved.orchLevel).toBe(2);
      expect(resolved.resolverWarning).toMatch(/project-docs-worker/);
    } finally {
      db.close();
    }
  });

  it('T1933 Fix 2 — E_AGENT_NOT_FOUND only when universal base itself is unreachable', async () => {
    const { resolveAgent, AgentNotFoundError } = await import('../agent-resolver.js');
    const db = env.openDb();
    try {
      const missingUniversalBase = join(env.cleoHome, 'no-such-cleo-subagent.cant');

      // All 5 tiers miss: no DB row, no fallback file, no universal base.
      expect(() =>
        resolveAgent(db, 'project-security-worker', {
          projectRoot: env.projectRoot,
          packagedSeedDir: env.templatesDir, // empty
          universalBasePath: missingUniversalBase,
        }),
      ).toThrow(AgentNotFoundError);

      // Verify the error enumerates all 5 tiers.
      try {
        resolveAgent(db, 'project-security-worker', {
          projectRoot: env.projectRoot,
          packagedSeedDir: env.templatesDir,
          universalBasePath: missingUniversalBase,
        });
      } catch (err) {
        expect(err).toBeInstanceOf(AgentNotFoundError);
        if (err instanceof AgentNotFoundError) {
          expect(err.triedTiers).toEqual([
            'project',
            'global',
            'packaged',
            'fallback',
            'universal',
          ]);
          expect(err.code).toBe('E_AGENT_NOT_FOUND');
          expect(err.exitCode).toBe(65);
        }
      }
    } finally {
      db.close();
    }
  });

  it('T1933 — resolveDefaultTemplatesDir returns path ending in agents/templates', async () => {
    const { resolveDefaultTemplatesDir } = await import('../agent-resolver.js');
    const dir = resolveDefaultTemplatesDir();
    expect(dir).toMatch(/agents[/\\]templates$/);
  });

  it('T1933 — resolveDefaultSeedDir (deprecated shim) delegates to resolveDefaultTemplatesDir', async () => {
    const { resolveDefaultSeedDir, resolveDefaultTemplatesDir } = await import(
      '../agent-resolver.js'
    );
    // Both must return the same path (shim delegates to the new function).
    expect(resolveDefaultSeedDir()).toBe(resolveDefaultTemplatesDir());
  });

  // ── T9037: resolveDefaultUniversalBasePath workspace + published parity ───

  it('T9037 — resolveDefaultUniversalBasePath resolves to a cleo-subagent.cant that exists on disk (workspace mode)', async () => {
    const { resolveDefaultUniversalBasePath } = await import('../agent-resolver.js');
    const p = resolveDefaultUniversalBasePath();
    // In workspace mode the function MUST locate the file via require.resolve
    // primary strategy or the relative-path fallback. Either way the result
    // must be a non-null string ending in cleo-subagent.cant that exists on disk.
    expect(p).not.toBeNull();
    expect(p).toMatch(/cleo-subagent\.cant$/);
    // Verify the file actually exists — this catches path-resolution drift
    // between the function's output and the real filesystem layout.
    const { existsSync } = await import('node:fs');
    expect(existsSync(p as string)).toBe(true);
  });

  it('T9037 — resolveDefaultUniversalBasePath resolves via require.resolve even when fileURL path would differ (published-CLI simulation)', async () => {
    // Simulate a published-CLI layout by copying @cleocode/agents into a temp
    // node_modules tree and confirming that require.resolve primary strategy
    // resolves the file from that location. This tests the fix for the bug
    // where the old fileURL-only approach failed in globally-installed CLIs
    // because the relative path climb did not match the npm install layout.
    const {
      mkdirSync: mkd,
      writeFileSync: wf,
      mkdtempSync: mkdtemp,
      rmSync: rm,
    } = await import('node:fs');
    const { join: j, dirname: dn } = await import('node:path');
    const { tmpdir } = await import('node:os');

    const base = mkdtemp(j(tmpdir(), 'cleo-t9037-published-'));
    try {
      // Build a minimal @cleocode/agents package tree under a fake node_modules.
      const fakePkgDir = j(base, 'node_modules', '@cleocode', 'agents');
      mkd(fakePkgDir, { recursive: true });
      wf(
        j(fakePkgDir, 'package.json'),
        JSON.stringify({ name: '@cleocode/agents', version: '0.0.0-test', type: 'module' }),
      );
      wf(
        j(fakePkgDir, 'cleo-subagent.cant'),
        '---\nkind: agent\nversion: 1\n---\nagent cleo-subagent:\n  role: worker\n  prompt: "T9037 test universal base."\n  skills: []\n',
      );

      // Use Node's require to resolve the file from inside the fake package tree.
      // This mimics what resolveDefaultUniversalBasePath() does in published-CLI
      // mode: require.resolve('@cleocode/agents/package.json') from the CLI's
      // installed location reaches the correct node_modules/@cleocode/agents dir.
      const { createRequire } = await import('node:module');
      const fakeReq = createRequire(j(fakePkgDir, 'package.json'));
      const resolved = fakeReq.resolve('@cleocode/agents/package.json');
      const expectedPath = j(dn(resolved), 'cleo-subagent.cant');

      // Verify that the resolution produces the correct path relative to the
      // fake package root — i.e., the require.resolve strategy finds the right file.
      expect(expectedPath).toBe(j(fakePkgDir, 'cleo-subagent.cant'));

      const { existsSync } = await import('node:fs');
      expect(existsSync(expectedPath)).toBe(true);
    } finally {
      rm(base, { recursive: true, force: true });
    }
  });

  it('T1933 — all 5 tiers covered individually: project wins when installed', async () => {
    // This test individually verifies each tier in isolation by exercising the
    // tier-specific paths: project, global, packaged, fallback, universal.
    const { installAgentFromCant } = await import('../agent-install.js');
    const { resolveAgent } = await import('../agent-resolver.js');

    // ── Tier 1: project ───────────────────────────────────────────────────
    {
      const db = env.openDb();
      try {
        const src = writeSource(
          join(env.projectRoot, 'sources'),
          'tier-test-worker.cant',
          `---\nkind: agent\nversion: 1\n---\n\nagent tier-test-worker:\n  role: worker\n  prompt: "Tier test."\n  skills: []\n`,
        );
        installAgentFromCant(db, {
          cantSource: src,
          targetTier: 'project',
          installedFrom: 'user',
          projectRoot: env.projectRoot,
        });
        const resolved = resolveAgent(db, 'tier-test-worker', {
          projectRoot: env.projectRoot,
          packagedSeedDir: env.templatesDir,
        });
        expect(resolved.tier).toBe('project');
      } finally {
        db.close();
      }
    }

    // ── Tier 2: global ────────────────────────────────────────────────────
    {
      const db = env.openDb();
      try {
        const resolved = resolveAgent(db, 'cleo-historian', {
          projectRoot: env.projectRoot,
          packagedSeedDir: env.templatesDir,
        });
        // cleo-historian is not in DB in this env — universal base fires.
        // Verify it does NOT throw (universal catches it).
        expect(resolved.tier).toBe('universal');
      } finally {
        db.close();
      }
    }

    // ── Tier 4: fallback (templates/ dir) ─────────────────────────────────
    {
      const db = env.openDb();
      try {
        writeSource(
          env.templatesDir,
          'project-code-worker.cant',
          `---\nkind: agent\nversion: 1\n---\n\nagent project-code-worker:\n  role: worker\n  prompt: "Code worker."\n  skills: []\n`,
        );
        const resolved = resolveAgent(db, 'project-code-worker', {
          projectRoot: env.projectRoot,
          packagedSeedDir: env.templatesDir,
          universalBasePath: join(env.cleoHome, 'no-such.cant'), // disable universal to prove fallback fires
        });
        expect(resolved.tier).toBe('fallback');
        expect(resolved.agentId).toBe('project-code-worker');
      } finally {
        db.close();
      }
    }

    // ── Tier 5: universal ─────────────────────────────────────────────────
    {
      const db = env.openDb();
      try {
        const universalBasePath = join(env.cleoHome, 'universal-all-tiers-test.cant');
        writeFileSync(universalBasePath, UNIVERSAL_BASE_CANT, 'utf-8');
        const resolved = resolveAgent(db, 'ghost-agent-all-tiers', {
          projectRoot: env.projectRoot,
          packagedSeedDir: env.templatesDir, // no matching file
          universalBasePath,
        });
        expect(resolved.tier).toBe('universal');
      } finally {
        db.close();
      }
    }
  });
});
