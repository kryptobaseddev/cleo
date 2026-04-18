/**
 * Tests for the canonical {@link composeSpawnPayload} composer (T889 / W3-1).
 *
 * Verifies:
 *  - Full `SpawnPayload` shape for tier 0/1/2.
 *  - `harnessHint: 'claude-code'` → dedupSavedChars = DEDUP_EMBED_CHARS.
 *  - `harnessHint: 'generic'` → dedupSavedChars = 0.
 *  - `role: 'worker'` with no AC.files → atomicity.allowed = false.
 *  - `role: 'worker'` with ≤ MAX_WORKER_FILES → atomicity.allowed = true.
 *  - Integration: real W2-3 install → W2-4 resolve → composer populates
 *    `resolvedAgent` with tier-sourced metadata.
 *
 * No mocks: every test uses the real SQLite registry + filesystem fixtures.
 *
 * @task T889 / T891 / W3-1
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Task } from '@cleocode/contracts';
import { ThinAgentViolationError } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEDUP_EMBED_CHARS } from '../harness-hint.js';
import { composeSpawnPayload } from '../spawn.js';

// ---------------------------------------------------------------------------
// Fixtures — match the agent-resolver.test.ts harness
// ---------------------------------------------------------------------------

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

const FIXTURE_LEAD_CANT = `---
kind: agent
version: 1
---

agent fixture-lead:
  role: lead
  parent: cleo-prime
  description: "Lead fixture."
  prompt: "You are fixture-lead."
  skills: ["ct-cleo"]
`;

interface TmpEnv {
  cleoHome: string;
  projectRoot: string;
  dbPath: string;
  globalCantDir: string;
  projectCantDir: string;
  openDb: () => DatabaseSync;
  cleanup: () => void;
}

async function makeTmpEnv(suffix: string): Promise<TmpEnv> {
  const base = mkdtempSync(join(tmpdir(), `cleo-w3-1-${suffix}-`));
  const cleoHome = join(base, 'cleo-home');
  const projectRoot = join(base, 'project');
  const globalCantDir = join(base, 'global-cant-agents');
  const projectCantDir = join(projectRoot, '.cleo', 'cant', 'agents');

  mkdirSync(cleoHome, { recursive: true });
  mkdirSync(projectCantDir, { recursive: true });
  mkdirSync(globalCantDir, { recursive: true });

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
    '../../store/signaldock-sqlite.js'
  );
  _resetGlobalSignaldockDb_TESTING_ONLY();
  await ensureGlobalSignaldockDb();

  const dbPath = join(cleoHome, 'signaldock.db');

  // Seed the skills catalog so junction writes succeed.
  const seedDb = new DatabaseSync(dbPath);
  seedDb.exec('PRAGMA foreign_keys = ON');
  const nowTs = Math.floor(Date.now() / 1000);
  seedDb
    .prepare(
      `INSERT OR IGNORE INTO skills (id, slug, name, description, category, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run('skill-ct-cleo', 'ct-cleo', 'CT CLEO', 'CLEO task protocol', 'core', nowTs);
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

// Install a single .cant at the global tier so the resolver finds it.
async function installFixture(
  db: DatabaseSync,
  env: TmpEnv,
  filename: string,
  body: string,
): Promise<void> {
  const { installAgentFromCant } = await import('../../store/agent-install.js');
  const src = writeSource(join(env.projectRoot, 'sources'), filename, body);
  installAgentFromCant(db, {
    cantSource: src,
    targetTier: 'global',
    installedFrom: 'seed',
    globalCantDir: env.globalCantDir,
  });
}

// ---------------------------------------------------------------------------
// Base task fixture
// ---------------------------------------------------------------------------

const BASE_TASK: Task = {
  id: 'T9101',
  title: 'Composer test task',
  description: 'Task used to exercise composeSpawnPayload.',
  status: 'pending',
  priority: 'medium',
  type: 'task',
  size: 'small',
  acceptance: ['AC1: verify composer shape'],
  createdAt: '2026-04-17T00:00:00Z',
};

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('composeSpawnPayload — full envelope', () => {
  let env: TmpEnv;

  beforeEach(async () => {
    vi.resetModules();
    env = await makeTmpEnv(Math.random().toString(36).slice(2));
  });

  afterEach(() => {
    env.cleanup();
    vi.restoreAllMocks();
  });

  it('returns full SpawnPayload shape for tier 0 (worker)', async () => {
    const db = env.openDb();
    try {
      await installFixture(db, env, 'fixture-worker.cant', FIXTURE_WORKER_CANT);
      const payload = await composeSpawnPayload(
        db,
        { ...BASE_TASK, files: ['packages/core/src/foo.ts'] },
        {
          agentId: 'fixture-worker',
          tier: 0,
          role: 'worker',
          harnessHint: 'generic',
          projectRoot: env.projectRoot,
        },
      );
      expect(payload.taskId).toBe('T9101');
      expect(payload.agentId).toBe('fixture-worker');
      expect(payload.role).toBe('worker');
      expect(payload.tier).toBe(0);
      expect(payload.harnessHint).toBe('generic');
      expect(payload.resolvedAgent.agentId).toBe('fixture-worker');
      expect(payload.atomicity.allowed).toBe(true);
      expect(payload.prompt).toContain('T9101');
      expect(payload.meta.composerVersion).toBe('3.0.0');
      expect(payload.meta.protocol).toBeTruthy();
      expect(payload.meta.promptChars).toBe(payload.prompt.length);
      expect(payload.meta.sourceTier).toBe('global');
    } finally {
      db.close();
    }
  });

  it('returns full SpawnPayload shape for tier 1 (lead)', async () => {
    const db = env.openDb();
    try {
      await installFixture(db, env, 'fixture-lead.cant', FIXTURE_LEAD_CANT);
      const payload = await composeSpawnPayload(db, BASE_TASK, {
        agentId: 'fixture-lead',
        tier: 1,
        role: 'lead',
        harnessHint: 'generic',
        projectRoot: env.projectRoot,
      });
      expect(payload.tier).toBe(1);
      expect(payload.role).toBe('lead');
      expect(payload.atomicity.allowed).toBe(true);
      // Lead + generic harness → full CLEO-INJECTION embed visible in prompt.
      expect(payload.prompt).toContain('## CLEO Protocol (embedded — tier 1)');
    } finally {
      db.close();
    }
  });

  it('returns full SpawnPayload shape for tier 2 (orchestrator)', async () => {
    const db = env.openDb();
    try {
      // Install a minimal orchestrator fixture so orchLevel=0 flows through.
      const FIXTURE_ORCHESTRATOR_CANT = `---
kind: agent
version: 1
---

agent fixture-orchestrator:
  role: orchestrator
  description: "Orchestrator fixture."
  prompt: "You are fixture-orchestrator."
  skills: []
`;
      await installFixture(db, env, 'fixture-orchestrator.cant', FIXTURE_ORCHESTRATOR_CANT);
      const payload = await composeSpawnPayload(db, BASE_TASK, {
        agentId: 'fixture-orchestrator',
        tier: 2,
        role: 'orchestrator',
        harnessHint: 'generic',
        projectRoot: env.projectRoot,
      });
      expect(payload.tier).toBe(2);
      expect(payload.role).toBe('orchestrator');
      expect(payload.atomicity.allowed).toBe(true);
      // Tier 2 + generic harness → skill excerpts AND anti-patterns present.
      expect(payload.prompt).toContain('## Skill Excerpts (tier 2)');
      expect(payload.prompt).toContain('## Anti-Patterns');
    } finally {
      db.close();
    }
  });
});

describe('composeSpawnPayload — harness dedup accounting', () => {
  let env: TmpEnv;

  beforeEach(async () => {
    vi.resetModules();
    env = await makeTmpEnv(Math.random().toString(36).slice(2));
  });

  afterEach(() => {
    env.cleanup();
    vi.restoreAllMocks();
  });

  it('harnessHint="claude-code" → dedupSavedChars = DEDUP_EMBED_CHARS', async () => {
    const db = env.openDb();
    try {
      await installFixture(db, env, 'fixture-lead.cant', FIXTURE_LEAD_CANT);
      const payload = await composeSpawnPayload(db, BASE_TASK, {
        agentId: 'fixture-lead',
        tier: 1,
        role: 'lead',
        harnessHint: 'claude-code',
        projectRoot: env.projectRoot,
      });
      expect(payload.harnessHint).toBe('claude-code');
      expect(payload.meta.dedupSavedChars).toBe(DEDUP_EMBED_CHARS);
      // Pointer replaces the embed — no tier-1 embed section in prompt.
      expect(payload.prompt).toContain('## CLEO Protocol (tier 1 — dedup pointer)');
      expect(payload.prompt).not.toContain('## CLEO Protocol (embedded — tier 1)');
      // Pointer body references the canonical AGENTS.md location.
      expect(payload.prompt).toContain('AGENTS.md harness');
    } finally {
      db.close();
    }
  });

  it('harnessHint="generic" → dedupSavedChars = 0', async () => {
    const db = env.openDb();
    try {
      await installFixture(db, env, 'fixture-lead.cant', FIXTURE_LEAD_CANT);
      const payload = await composeSpawnPayload(db, BASE_TASK, {
        agentId: 'fixture-lead',
        tier: 1,
        role: 'lead',
        harnessHint: 'generic',
        projectRoot: env.projectRoot,
      });
      expect(payload.harnessHint).toBe('generic');
      expect(payload.meta.dedupSavedChars).toBe(0);
      expect(payload.prompt).toContain('## CLEO Protocol (embedded — tier 1)');
    } finally {
      db.close();
    }
  });
});

describe('composeSpawnPayload — atomicity gate', () => {
  let env: TmpEnv;

  beforeEach(async () => {
    vi.resetModules();
    env = await makeTmpEnv(Math.random().toString(36).slice(2));
  });

  afterEach(() => {
    env.cleanup();
    vi.restoreAllMocks();
  });

  it('role=worker + no AC.files → atomicity.allowed = false (E_ATOMICITY_NO_SCOPE)', async () => {
    const db = env.openDb();
    try {
      await installFixture(db, env, 'fixture-worker.cant', FIXTURE_WORKER_CANT);
      const payload = await composeSpawnPayload(
        db,
        { ...BASE_TASK, files: undefined },
        {
          agentId: 'fixture-worker',
          role: 'worker',
          tier: 0,
          harnessHint: 'generic',
          projectRoot: env.projectRoot,
        },
      );
      expect(payload.atomicity.allowed).toBe(false);
      expect(payload.atomicity.code).toBe('E_ATOMICITY_NO_SCOPE');
    } finally {
      db.close();
    }
  });

  it('role=worker + 3 AC.files → atomicity.allowed = true', async () => {
    const db = env.openDb();
    try {
      await installFixture(db, env, 'fixture-worker.cant', FIXTURE_WORKER_CANT);
      const payload = await composeSpawnPayload(
        db,
        { ...BASE_TASK, files: ['a.ts', 'b.ts', 'c.ts'] },
        {
          agentId: 'fixture-worker',
          role: 'worker',
          tier: 0,
          harnessHint: 'generic',
          projectRoot: env.projectRoot,
        },
      );
      expect(payload.atomicity.allowed).toBe(true);
      expect(payload.atomicity.meta?.fileCount).toBe(3);
    } finally {
      db.close();
    }
  });

  it('skipAtomicityCheck=true bypasses the gate even for worker role without files', async () => {
    const db = env.openDb();
    try {
      await installFixture(db, env, 'fixture-worker.cant', FIXTURE_WORKER_CANT);
      const payload = await composeSpawnPayload(
        db,
        { ...BASE_TASK, files: undefined },
        {
          agentId: 'fixture-worker',
          role: 'worker',
          tier: 0,
          harnessHint: 'generic',
          projectRoot: env.projectRoot,
          skipAtomicityCheck: true,
        },
      );
      expect(payload.atomicity.allowed).toBe(true);
    } finally {
      db.close();
    }
  });
});

describe('composeSpawnPayload — real-registry integration', () => {
  let env: TmpEnv;

  beforeEach(async () => {
    vi.resetModules();
    env = await makeTmpEnv(Math.random().toString(36).slice(2));
  });

  afterEach(() => {
    env.cleanup();
    vi.restoreAllMocks();
  });

  it('installs agent via W2-3, composes payload, resolvedAgent populated from registry', async () => {
    const db = env.openDb();
    try {
      await installFixture(db, env, 'fixture-lead.cant', FIXTURE_LEAD_CANT);
      const payload = await composeSpawnPayload(
        db,
        { ...BASE_TASK, files: ['src/a.ts'] },
        {
          agentId: 'fixture-lead',
          harnessHint: 'generic',
          projectRoot: env.projectRoot,
        },
      );
      // Agent metadata comes directly from the registry (no mocks).
      expect(payload.resolvedAgent.agentId).toBe('fixture-lead');
      expect(payload.resolvedAgent.tier).toBe('global');
      expect(payload.resolvedAgent.cantSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(payload.resolvedAgent.skills).toEqual(expect.arrayContaining(['ct-cleo']));
      // Role derived from orch_level in the registry.
      expect(payload.role).toBe('lead');
      expect(payload.tier).toBe(1);
    } finally {
      db.close();
    }
  });
});

describe('composeSpawnPayload — thin-agent runtime enforcer (T931)', () => {
  let env: TmpEnv;

  beforeEach(async () => {
    vi.resetModules();
    env = await makeTmpEnv(Math.random().toString(36).slice(2));
  });

  afterEach(() => {
    env.cleanup();
    vi.restoreAllMocks();
  });

  it('throws ThinAgentViolationError when worker payload declares Agent tool', async () => {
    const db = env.openDb();
    try {
      await installFixture(db, env, 'fixture-worker.cant', FIXTURE_WORKER_CANT);
      await expect(
        composeSpawnPayload(
          db,
          { ...BASE_TASK, files: ['src/a.ts'] },
          {
            agentId: 'fixture-worker',
            role: 'worker',
            tier: 0,
            harnessHint: 'generic',
            projectRoot: env.projectRoot,
            tools: ['Agent', 'Read'],
          },
        ),
      ).rejects.toBeInstanceOf(ThinAgentViolationError);
    } finally {
      db.close();
    }
  });

  it('throws ThinAgentViolationError when worker payload declares Task tool', async () => {
    const db = env.openDb();
    try {
      await installFixture(db, env, 'fixture-worker.cant', FIXTURE_WORKER_CANT);
      await expect(
        composeSpawnPayload(
          db,
          { ...BASE_TASK, files: ['src/a.ts'] },
          {
            agentId: 'fixture-worker',
            role: 'worker',
            tier: 0,
            harnessHint: 'generic',
            projectRoot: env.projectRoot,
            tools: ['Task'],
          },
        ),
      ).rejects.toBeInstanceOf(ThinAgentViolationError);
    } finally {
      db.close();
    }
  });

  it('allows worker with only safe tools and surfaces mode in meta', async () => {
    const db = env.openDb();
    try {
      await installFixture(db, env, 'fixture-worker.cant', FIXTURE_WORKER_CANT);
      const payload = await composeSpawnPayload(
        db,
        { ...BASE_TASK, files: ['src/a.ts'] },
        {
          agentId: 'fixture-worker',
          role: 'worker',
          tier: 0,
          harnessHint: 'generic',
          projectRoot: env.projectRoot,
          tools: ['Read', 'Edit'],
        },
      );
      expect(payload.meta.thinAgent?.mode).toBe('strict');
      expect(payload.meta.thinAgent?.stripped).toEqual([]);
      expect(payload.meta.thinAgent?.bypassed).toBe(false);
    } finally {
      db.close();
    }
  });

  it('strip mode: worker with Agent/Task yields stripped tools and metadata', async () => {
    const db = env.openDb();
    try {
      await installFixture(db, env, 'fixture-worker.cant', FIXTURE_WORKER_CANT);
      const payload = await composeSpawnPayload(
        db,
        { ...BASE_TASK, files: ['src/a.ts'] },
        {
          agentId: 'fixture-worker',
          role: 'worker',
          tier: 0,
          harnessHint: 'generic',
          projectRoot: env.projectRoot,
          tools: ['Agent', 'Read'],
          thinAgentEnforcement: 'strip',
        },
      );
      expect(payload.meta.thinAgent?.mode).toBe('strip');
      expect(payload.meta.thinAgent?.stripped).toEqual(['Agent']);
      expect(payload.meta.thinAgent?.bypassed).toBe(false);
    } finally {
      db.close();
    }
  });

  it('off mode: worker with Agent succeeds with bypassed flag set', async () => {
    const db = env.openDb();
    try {
      await installFixture(db, env, 'fixture-worker.cant', FIXTURE_WORKER_CANT);
      const payload = await composeSpawnPayload(
        db,
        { ...BASE_TASK, files: ['src/a.ts'] },
        {
          agentId: 'fixture-worker',
          role: 'worker',
          tier: 0,
          harnessHint: 'generic',
          projectRoot: env.projectRoot,
          tools: ['Agent', 'Task', 'Read'],
          thinAgentEnforcement: 'off',
        },
      );
      expect(payload.meta.thinAgent?.mode).toBe('off');
      expect(payload.meta.thinAgent?.bypassed).toBe(true);
    } finally {
      db.close();
    }
  });

  it('lead with Agent tool passes unchanged — leads are permitted to spawn', async () => {
    const db = env.openDb();
    try {
      await installFixture(db, env, 'fixture-lead.cant', FIXTURE_LEAD_CANT);
      const payload = await composeSpawnPayload(db, BASE_TASK, {
        agentId: 'fixture-lead',
        role: 'lead',
        tier: 1,
        harnessHint: 'generic',
        projectRoot: env.projectRoot,
        tools: ['Agent', 'Task', 'Read'],
      });
      expect(payload.meta.thinAgent?.mode).toBe('strict');
      expect(payload.meta.thinAgent?.stripped).toEqual([]);
      expect(payload.role).toBe('lead');
    } finally {
      db.close();
    }
  });

  it('no-op when tools option omitted — thinAgent meta is undefined', async () => {
    const db = env.openDb();
    try {
      await installFixture(db, env, 'fixture-worker.cant', FIXTURE_WORKER_CANT);
      const payload = await composeSpawnPayload(
        db,
        { ...BASE_TASK, files: ['src/a.ts'] },
        {
          agentId: 'fixture-worker',
          role: 'worker',
          tier: 0,
          harnessHint: 'generic',
          projectRoot: env.projectRoot,
        },
      );
      expect(payload.meta.thinAgent).toBeUndefined();
    } finally {
      db.close();
    }
  });
});
