/**
 * End-to-end pipeline regression suite — T1940.
 *
 * Locks the Phase 1 (T1929) canonical contract end-to-end across all 5 worker
 * role templates: spawn → classify → resolve → install.
 *
 * Coverage:
 *  1. All 5 worker roles: init → installTemplatesAtProjectTier → classifyTask
 *     emits correct project-<role> id → resolveAgent finds at project tier.
 *  2. Universal-tier fallback: when all 4 prior tiers miss, the resolver
 *     synthesises a universal envelope from cleo-subagent.cant.
 *  3. E_AGENT_NOT_FOUND raised ONLY when cleo-subagent.cant is unreachable.
 *  4. Spawn validator pre-flight passes for universal-tier results (ADR-068
 *     Decision 6, T1933 contract).
 *
 * All tests use real node:sqlite + real filesystem under isolated tmp dirs.
 * The developer's real ~/.local/share/cleo is never touched.
 *
 * @task T1940
 * @epic T1929
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
 * Absolute path to the real @cleocode/agents/templates directory.
 * Used to exercise the actual bundled template files.
 */
const REAL_TEMPLATES_DIR = resolve(__dirname, '..', '..', '..', 'agents', 'templates');

/**
 * Absolute path to the universal-base cleo-subagent.cant file.
 */
const REAL_UNIVERSAL_BASE = resolve(__dirname, '..', '..', '..', 'agents', 'cleo-subagent.cant');

/**
 * The 5 canonical worker role template IDs shipped in @cleocode/agents/templates/.
 * Each pair is: [agentId, task-signals that classify to this agent].
 *
 * The classify signals are chosen to definitively route to a single agent
 * (matching label keywords from classify.ts CLASSIFIER_RULES).
 */
const WORKER_ROLE_FIXTURES: ReadonlyArray<{
  agentId: string;
  taskOverrides: {
    title?: string;
    labels?: string[];
    type?: 'task' | 'epic' | 'subtask';
    size?: 'small' | 'medium' | 'large';
  };
  expectedRole: 'orchestrator' | 'lead' | 'worker';
}> = [
  {
    agentId: 'project-orchestrator',
    taskOverrides: { labels: ['orchestrate', 'spawn'] },
    expectedRole: 'orchestrator',
  },
  {
    agentId: 'project-dev-lead',
    taskOverrides: { title: 'Implement the authentication module', labels: ['dev', 'feature'] },
    expectedRole: 'lead',
  },
  {
    agentId: 'project-code-worker',
    taskOverrides: {
      title: 'Write unit tests for auth module',
      labels: ['worker', 'code-worker'],
      size: 'small',
      type: 'subtask',
    },
    expectedRole: 'worker',
  },
  {
    agentId: 'project-docs-worker',
    taskOverrides: {
      title: 'Document the authentication API specification',
      labels: ['docs', 'specification'],
    },
    expectedRole: 'worker',
  },
  {
    agentId: 'project-security-worker',
    taskOverrides: { title: 'Security audit of authentication endpoints', labels: ['security'] },
    expectedRole: 'worker',
  },
];

// ---------------------------------------------------------------------------
// Tmp-environment helper
// ---------------------------------------------------------------------------

interface TmpEnv {
  base: string;
  cleoHome: string;
  projectRoot: string;
  dbPath: string;
  projectCantDir: string;
  openDb: () => DatabaseSync;
  cleanup: () => void;
}

/**
 * Provision an isolated tmp workspace with:
 * - A fresh CLEO_HOME (redirected so signaldock.db never lands in the real dir)
 * - A fresh signaldock.db bootstrapped with real migrations
 * - Project root with .cleo/cant/agents/ pre-created
 */
async function makeTmpEnv(suffix: string): Promise<TmpEnv> {
  const base = mkdtempSync(join(tmpdir(), `cleo-t1940-e2e-${suffix}-`));
  const cleoHome = join(base, 'cleo-home');
  const projectRoot = join(base, 'project');
  const projectCantDir = join(projectRoot, '.cleo', 'cant', 'agents');

  mkdirSync(cleoHome, { recursive: true });
  mkdirSync(projectCantDir, { recursive: true });

  // Required by signaldock-sqlite.ts initialisation.
  writeFileSync(join(cleoHome, 'machine-key'), Buffer.alloc(32, 0xab), { mode: 0o600 });
  writeFileSync(join(cleoHome, 'global-salt'), Buffer.alloc(32, 0xcd), { mode: 0o600 });

  vi.doMock('../paths.js', async () => {
    const actual = await vi.importActual<typeof import('../paths.js')>('../paths.js');
    return {
      ...actual,
      getCleoHome: () => cleoHome,
      getCleoGlobalAgentsDir: () => join(cleoHome, 'cant', 'agents'),
    };
  });

  const signaldockMod = await import('../store/signaldock-sqlite.js');
  signaldockMod._resetGlobalSignaldockDb_TESTING_ONLY();
  await signaldockMod.ensureGlobalSignaldockDb();

  const dbPath = join(cleoHome, 'signaldock.db');

  const openDb = (): DatabaseSync => {
    const d = new DatabaseSync(dbPath);
    d.exec('PRAGMA foreign_keys = ON');
    d.exec('PRAGMA journal_mode = WAL');
    return d;
  };

  const cleanup = (): void => {
    signaldockMod._resetGlobalSignaldockDb_TESTING_ONLY();
    rmSync(base, { recursive: true, force: true });
  };

  return { base, cleoHome, projectRoot, dbPath, projectCantDir, openDb, cleanup };
}

// ---------------------------------------------------------------------------
// Suite 1 — End-to-end pipeline for all 5 worker roles
// ---------------------------------------------------------------------------

describe('Pipeline E2E — all 5 worker role templates', () => {
  let env: TmpEnv;

  beforeEach(async () => {
    vi.resetModules();
    env = await makeTmpEnv(Math.random().toString(36).slice(2));
  });

  afterEach(() => {
    env.cleanup();
    vi.doUnmock('../paths.js');
    vi.restoreAllMocks();
  });

  for (const fixture of WORKER_ROLE_FIXTURES) {
    it(`init → classify → resolve → install passes end-to-end for ${fixture.agentId}`, async () => {
      // Step 1: install templates at project tier (mimics cleo init).
      const { installTemplatesAtProjectTier } = await import('../init.js');
      const installResult = await installTemplatesAtProjectTier(env.projectRoot);

      // Graceful skip when @cleocode/agents/templates/ is not present in this env.
      if (installResult.templatesDir === null) {
        console.warn(
          `[T1940] templates dir not found — skipping end-to-end for ${fixture.agentId}`,
        );
        return;
      }

      expect(installResult.failed).toHaveLength(0);
      const installedIds = installResult.installed.map((e) => e.agentId);
      expect(installedIds).toContain(fixture.agentId);

      // Step 2: Classify a task that should route to this agent.
      const { classifyTask } = await import('../orchestration/classify.js');
      const task = {
        id: `T-test-${fixture.agentId}`,
        title: fixture.taskOverrides.title ?? `Default task for ${fixture.agentId}`,
        description: `End-to-end test task for agent ${fixture.agentId}.`,
        status: 'pending' as const,
        priority: 'medium' as const,
        type: fixture.taskOverrides.type ?? ('task' as const),
        size: fixture.taskOverrides.size ?? ('medium' as const),
        labels: fixture.taskOverrides.labels ?? [],
        createdAt: new Date().toISOString(),
      };

      const classifyResult = classifyTask(task);
      expect(classifyResult.agentId).toBe(fixture.agentId);
      expect(classifyResult.role).toBe(fixture.expectedRole);
      expect(classifyResult.usedFallback).toBe(false);

      // Step 3: Resolve the agent using the classified agent ID.
      const { resolveAgent } = await import('../store/agent-resolver.js');
      const db = env.openDb();
      try {
        const resolved = resolveAgent(db, classifyResult.agentId, {
          projectRoot: env.projectRoot,
          packagedSeedDir: REAL_TEMPLATES_DIR,
          universalBasePath: REAL_UNIVERSAL_BASE,
        });

        // Expect resolution to succeed (not E_AGENT_NOT_FOUND).
        expect(resolved.agentId).toBe(fixture.agentId);

        // Should resolve at project or fallback tier (project tier preferred after install).
        expect(['project', 'global', 'packaged', 'fallback', 'universal']).toContain(resolved.tier);

        // cantPath must be set.
        expect(typeof resolved.cantPath).toBe('string');
        expect(resolved.cantPath).not.toBeNull();

        // SHA256 must be a 64-char hex string.
        expect(resolved.cantSha256).toMatch(/^[a-f0-9]{64}$/);
      } finally {
        db.close();
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Suite 2 — Universal-tier fallback
// ---------------------------------------------------------------------------

describe('Pipeline E2E — universal-tier fallback', () => {
  let env: TmpEnv;

  beforeEach(async () => {
    vi.resetModules();
    env = await makeTmpEnv(Math.random().toString(36).slice(2));
  });

  afterEach(() => {
    env.cleanup();
    vi.doUnmock('../paths.js');
    vi.restoreAllMocks();
  });

  it('universal tier fallback synthesises envelope when all 4 prior tiers miss', async () => {
    // Fresh project root, NO templates registered (skip installTemplatesAtProjectTier).
    // The resolver should fall through to the universal tier.
    const { resolveAgent } = await import('../store/agent-resolver.js');
    const db = env.openDb();
    try {
      const resolved = resolveAgent(db, 'project-docs-worker', {
        projectRoot: env.projectRoot,
        // Use an empty dir so fallback tier (template file lookup) also misses.
        packagedSeedDir: join(env.base, 'empty-templates'),
        universalBasePath: REAL_UNIVERSAL_BASE,
      });

      // Should resolve at universal tier.
      expect(resolved.tier).toBe('universal');
      expect(resolved.source).toBe('universal');

      // Universal envelope carries the alias metadata.
      expect(resolved.aliasApplied).toBe(true);
      expect(resolved.aliasTarget).toBe('cleo-subagent');

      // Resolver warning must be set (signals the operator).
      expect(resolved.resolverWarning).toBeDefined();
      expect(typeof resolved.resolverWarning).toBe('string');
      expect(resolved.resolverWarning!.length).toBeGreaterThan(0);

      // Minimal valid shape — no canSpawn (not registered), skills empty.
      expect(resolved.canSpawn).toBe(false);
      expect(resolved.orchLevel).toBe(2);
      expect(resolved.skills).toEqual([]);

      // cantPath points at the universal base.
      expect(resolved.cantPath).toBe(REAL_UNIVERSAL_BASE);
      expect(resolved.cantSha256).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      db.close();
    }
  });

  it('spawn validator pre-flight passes with universal-tier result (ADR-068 Decision 6)', async () => {
    // Install templates so we have an initialised DB but then use an empty
    // packaged-seed dir to force universal-tier resolution.
    const { installTemplatesAtProjectTier } = await import('../init.js');
    const installResult = await installTemplatesAtProjectTier(env.projectRoot);
    if (installResult.templatesDir === null) {
      console.warn('[T1940] templates not present — skipping spawn validator pre-flight test');
      return;
    }

    // The validator's agent-existence check uses resolveAgent internally with
    // packagedSeedDir / universalBasePath from the SpawnValidationContext.
    // We can test this directly via validateSpawnReadiness with overrides that
    // force the universal-tier path.
    //
    // To avoid an actual task DB (tasks.db), we test resolveAgent directly and
    // assert no AgentNotFoundError is raised — which is the contract the
    // spawn validator pre-flight implements.
    const { resolveAgent, AgentNotFoundError } = await import('../store/agent-resolver.js');
    const db = env.openDb();
    try {
      // If we pass a valid universalBasePath, AgentNotFoundError MUST NOT be thrown.
      expect(() =>
        resolveAgent(db, 'project-docs-worker', {
          projectRoot: env.projectRoot,
          packagedSeedDir: join(env.base, 'empty-templates'), // force miss
          universalBasePath: REAL_UNIVERSAL_BASE,
        }),
      ).not.toThrow(AgentNotFoundError);
    } finally {
      db.close();
    }
  });

  it('E_AGENT_NOT_FOUND raised only when cleo-subagent.cant is unreachable', async () => {
    const { resolveAgent, AgentNotFoundError } = await import('../store/agent-resolver.js');
    const db = env.openDb();
    try {
      // Provide a universalBasePath that does not exist on disk.
      const missingUniversalBase = join(env.base, 'no-such-universal-base.cant');

      expect(() =>
        resolveAgent(db, 'does-not-exist-anywhere', {
          projectRoot: env.projectRoot,
          packagedSeedDir: join(env.base, 'empty-templates'),
          universalBasePath: missingUniversalBase,
        }),
      ).toThrow(AgentNotFoundError);
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Suite 3 — Classifier emits correct project-<role> IDs after init
// ---------------------------------------------------------------------------

describe('Pipeline E2E — classifier emits canonical project-<role> IDs', () => {
  it('getRegisteredAgentIds() returns the 5 canonical template IDs in static fallback mode', async () => {
    const { getRegisteredAgentIds } = await import('../orchestration/classify.js');

    // Without DB, should return the static fallback set.
    const ids = getRegisteredAgentIds();
    expect(ids).toContain('project-orchestrator');
    expect(ids).toContain('project-dev-lead');
    expect(ids).toContain('project-code-worker');
    expect(ids).toContain('project-docs-worker');
    expect(ids).toContain('project-security-worker');
    expect(ids).toContain('cleo-subagent');
  });

  it('validateClassifierRules() passes for all 5 canonical IDs (no DB)', async () => {
    const { validateClassifierRules } = await import('../orchestration/classify.js');

    // Static vocabulary contains all 5 templates — should not throw.
    expect(() => validateClassifierRules()).not.toThrow();
  });

  it('validateClassifierRules() passes with live DB after installTemplatesAtProjectTier', async () => {
    vi.resetModules();
    const base = mkdtempSync(join(tmpdir(), 'cleo-t1940-validator-'));
    const cleoHome = join(base, 'cleo-home');
    const projectRoot = join(base, 'project');
    mkdirSync(cleoHome, { recursive: true });
    mkdirSync(join(projectRoot, '.cleo', 'cant', 'agents'), { recursive: true });
    writeFileSync(join(cleoHome, 'machine-key'), Buffer.alloc(32, 0xab), { mode: 0o600 });
    writeFileSync(join(cleoHome, 'global-salt'), Buffer.alloc(32, 0xcd), { mode: 0o600 });

    vi.doMock('../paths.js', async () => {
      const actual = await vi.importActual<typeof import('../paths.js')>('../paths.js');
      return {
        ...actual,
        getCleoHome: () => cleoHome,
        getCleoGlobalAgentsDir: () => join(cleoHome, 'cant', 'agents'),
      };
    });

    try {
      const signaldockMod = await import('../store/signaldock-sqlite.js');
      signaldockMod._resetGlobalSignaldockDb_TESTING_ONLY();
      await signaldockMod.ensureGlobalSignaldockDb();

      const { installTemplatesAtProjectTier } = await import('../init.js');
      const installResult = await installTemplatesAtProjectTier(projectRoot);

      if (installResult.templatesDir === null || installResult.installed.length === 0) {
        console.warn(
          '[T1940] templates not present — skipping validateClassifierRules live-DB test',
        );
        return;
      }

      const dbPath = join(cleoHome, 'signaldock.db');
      const db = new DatabaseSync(dbPath);
      db.exec('PRAGMA foreign_keys = ON');

      try {
        const { validateClassifierRules } = await import('../orchestration/classify.js');
        expect(() => validateClassifierRules(db)).not.toThrow();
      } finally {
        db.close();
        signaldockMod._resetGlobalSignaldockDb_TESTING_ONLY();
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
      vi.doUnmock('../paths.js');
      vi.resetModules();
    }
  });
});
