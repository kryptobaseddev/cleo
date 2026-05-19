/**
 * Subdir-isolation tests for the T9582 project-root resolution fix.
 *
 * Verifies that the `cleo agent <verb>` CLI handlers in
 * `packages/cleo/src/cli/commands/agent.ts` resolve the effective project
 * root through `getProjectRoot()` rather than raw `process.cwd()`. The
 * regression scenario is invocation from a monorepo subdirectory
 * (`<root>/packages/<X>`) — without normalization, each call previously
 * wrote to `<root>/packages/<X>/.cleo/...` instead of the canonical
 * `<root>/.cleo/...`, silently corrupting state.
 *
 * The tests use the dynamic-import seam in agent.ts: each `cleo agent`
 * subcommand imports `@cleocode/core/internal` inside its `run` handler,
 * so we mock that module and capture the `projectRoot` argument passed
 * to the registry accessor / lookup / list helpers. Then we cross-check
 * that capture against the canonical project root returned by
 * `getProjectRoot()` (resolved by walking up from the temp fixture).
 *
 * The regression scenario is exercised via `process.chdir(subDir)` — the
 * subcommand handler is invoked with cwd inside the synthetic subdir,
 * and we assert the captured projectRoot equals the canonical fixture
 * root, NOT the subdir.
 *
 * @task T9582
 * @epic T9580
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentCommand } from '../agent.js';

// ---------------------------------------------------------------------------
// Captured projectRoot arguments — reset in beforeEach()
// ---------------------------------------------------------------------------

const captured = {
  /** projectRoot passed to `new AgentRegistryAccessor(projectRoot)`. */
  accessorRoot: undefined as string | undefined,
  /** projectRoot passed to `listAgentsForProject(projectRoot, opts)`. */
  listRoot: undefined as string | undefined,
  /** projectRoot passed to `lookupAgent(projectRoot, agentId, opts)`. */
  lookupRoot: undefined as string | undefined,
  /** projectRoot passed to `attachAgentToProject(projectRoot, ...)`. */
  attachRoot: undefined as string | undefined,
  /** projectRoot passed to `detachAgentFromProject(projectRoot, ...)`. */
  detachRoot: undefined as string | undefined,
  /** projectRoot passed to `getProjectAgentRef(projectRoot, ...)`. */
  getRefRoot: undefined as string | undefined,
};

function resetCaptured(): void {
  captured.accessorRoot = undefined;
  captured.listRoot = undefined;
  captured.lookupRoot = undefined;
  captured.attachRoot = undefined;
  captured.detachRoot = undefined;
  captured.getRefRoot = undefined;
}

// ---------------------------------------------------------------------------
// Mock @cleocode/core/internal — record projectRoot captures, stub
// downstream operations so handlers exit through the success path.
// ---------------------------------------------------------------------------

vi.mock('@cleocode/core/internal', async () => {
  // Resolve the REAL getProjectRoot so the test exercises the canonical
  // path walk (worktree + git-link + walk-up). All other exports are stubbed.
  const realPaths = await vi.importActual<typeof import('../../../../../core/src/paths.js')>(
    '../../../../../core/src/paths.js',
  );
  return {
    getProjectRoot: realPaths.getProjectRoot,
    getDb: vi.fn().mockResolvedValue(undefined),
    AgentRegistryAccessor: class AgentRegistryAccessor {
      constructor(projectRoot: string) {
        captured.accessorRoot = projectRoot;
      }
      async register(): Promise<{ agentId: string; displayName: string }> {
        return { agentId: 'agent-test', displayName: 'Test Agent' };
      }
      async get(): Promise<null> {
        return null;
      }
      async getActive(): Promise<null> {
        return null;
      }
    },
    listAgentsForProject: (projectRoot: string) => {
      captured.listRoot = projectRoot;
      return [];
    },
    lookupAgent: (projectRoot: string) => {
      captured.lookupRoot = projectRoot;
      return null;
    },
    attachAgentToProject: (projectRoot: string) => {
      captured.attachRoot = projectRoot;
    },
    detachAgentFromProject: (projectRoot: string) => {
      captured.detachRoot = projectRoot;
    },
    getProjectAgentRef: (projectRoot: string) => {
      captured.getRefRoot = projectRoot;
      return null;
    },
    checkAgentHealth: vi.fn(),
    detectCrashedAgents: vi.fn(),
    detectStaleAgents: vi.fn(),
    getHealthReport: vi.fn(),
    STALE_THRESHOLD_MS: 60_000,
  };
});

// Mock cliOutput / cliError so the assertions stay clean.
vi.mock('../../renderers/index.js', () => ({
  cliOutput: vi.fn(),
  cliError: vi.fn(),
  humanLine: vi.fn(),
  humanWarn: vi.fn(),
  humanInfo: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Test fixture: a synthetic project root with a deeply nested subdir.
// ---------------------------------------------------------------------------

interface Fixture {
  /** Canonical project root: `<tmp>/proj-<rand>` with `.cleo/` + `.git/`. */
  rootDir: string;
  /** Monorepo subdir below the root: `<rootDir>/packages/core`. */
  subDir: string;
}

function makeFixture(): Fixture {
  const rootDir = mkdtempSync(join(tmpdir(), 'cleo-agent-subdir-iso-'));
  // getProjectRoot()'s validateProjectRoot() requires `.cleo/` AND
  // (`.git/` directory OR `.cleo/project-info.json`). Provide both.
  mkdirSync(join(rootDir, '.cleo'), { recursive: true });
  mkdirSync(join(rootDir, '.git'), { recursive: true });
  writeFileSync(
    join(rootDir, '.cleo', 'project-info.json'),
    JSON.stringify({ projectId: 'agent-subdir-iso-test' }),
  );
  const subDir = join(rootDir, 'packages', 'core');
  mkdirSync(subDir, { recursive: true });
  return { rootDir, subDir };
}

/**
 * Snapshot and clear all CLEO_* env vars so the resolution path walks
 * the filesystem from cwd rather than honoring an operator-set override.
 */
function useCleanEnv(): { restore: () => void } {
  const saved: Record<string, string | undefined> = {
    CLEO_ROOT: process.env['CLEO_ROOT'],
    CLEO_PROJECT_ROOT: process.env['CLEO_PROJECT_ROOT'],
    CLEO_DIR: process.env['CLEO_DIR'],
  };
  delete process.env['CLEO_ROOT'];
  delete process.env['CLEO_PROJECT_ROOT'];
  delete process.env['CLEO_DIR'];
  return {
    restore() {
      for (const [key, val] of Object.entries(saved)) {
        if (val !== undefined) {
          process.env[key] = val;
        } else {
          delete process.env[key];
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Run-handler extraction helper
// ---------------------------------------------------------------------------

type RunContext = { args: Record<string, unknown>; rawArgs: string[] };
type RunFn = (ctx: RunContext) => Promise<void>;

function getAgentSubRun(subName: string): RunFn {
  const subs = agentCommand.subCommands as Record<string, { run?: RunFn }>;
  const sub = subs[subName];
  if (!sub?.run) {
    throw new Error(`agent ${subName} subcommand has no run function`);
  }
  return sub.run;
}

// ---------------------------------------------------------------------------
// Suite: agent CLI handlers resolve canonical project root from subdir
// ---------------------------------------------------------------------------

describe('T9582 — cleo agent: project-root resolution from monorepo subdir', () => {
  let fixture: Fixture;
  let origCwd: string;
  let restoreEnv: () => void;

  beforeEach(() => {
    origCwd = process.cwd();
    const env = useCleanEnv();
    restoreEnv = env.restore;
    fixture = makeFixture();
    resetCaptured();
    process.exitCode = undefined;
  });

  afterEach(() => {
    try {
      process.chdir(origCwd);
    } catch {
      /* ignore */
    }
    restoreEnv();
    try {
      rmSync(fixture.rootDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('cleo agent list reads registry against the canonical project root, not the subdir', async () => {
    process.chdir(fixture.subDir);

    const run = getAgentSubRun('list');
    await run({ args: {}, rawArgs: [] });

    expect(captured.listRoot).toBe(fixture.rootDir);
    expect(captured.listRoot).not.toBe(fixture.subDir);
  });

  it('cleo agent get looks up the agent against the canonical project root, not the subdir', async () => {
    process.chdir(fixture.subDir);

    const run = getAgentSubRun('get');
    await run({ args: { agentId: 'agent-test' }, rawArgs: [] });

    expect(captured.lookupRoot).toBe(fixture.rootDir);
    expect(captured.lookupRoot).not.toBe(fixture.subDir);
  });

  it('cleo agent attach uses the canonical project root for both accessor + attach', async () => {
    process.chdir(fixture.subDir);

    // Make lookupAgent return a "found" record so the attach handler proceeds
    // past its E_NOT_FOUND guard.
    const internal = await import('@cleocode/core/internal');
    const lookupSpy = vi
      .spyOn(internal, 'lookupAgent')
      .mockImplementation((projectRoot: string) => {
        captured.lookupRoot = projectRoot;
        return {
          agentId: 'agent-test',
          displayName: 'Test Agent',
        } as unknown as ReturnType<typeof internal.lookupAgent>;
      });

    try {
      const run = getAgentSubRun('attach');
      await run({ args: { agentId: 'agent-test' }, rawArgs: [] });
    } finally {
      lookupSpy.mockRestore();
    }

    expect(captured.accessorRoot).toBe(fixture.rootDir);
    expect(captured.lookupRoot).toBe(fixture.rootDir);
    expect(captured.attachRoot).toBe(fixture.rootDir);
  });

  it('cleo agent detach uses the canonical project root for the ref lookup', async () => {
    process.chdir(fixture.subDir);

    // Make getProjectAgentRef return a "found" ref so detach proceeds.
    const internal = await import('@cleocode/core/internal');
    const refSpy = vi
      .spyOn(internal, 'getProjectAgentRef')
      .mockImplementation((projectRoot: string) => {
        captured.getRefRoot = projectRoot;
        return { agentId: 'agent-test', enabled: 1 } as unknown as ReturnType<
          typeof internal.getProjectAgentRef
        >;
      });

    try {
      const run = getAgentSubRun('detach');
      await run({ args: { agentId: 'agent-test' }, rawArgs: [] });
    } finally {
      refSpy.mockRestore();
    }

    expect(captured.accessorRoot).toBe(fixture.rootDir);
    expect(captured.getRefRoot).toBe(fixture.rootDir);
    expect(captured.detachRoot).toBe(fixture.rootDir);
  });

  it('CLEO_ROOT env var overrides cwd-derived resolution (sanity check)', async () => {
    // When CLEO_ROOT is set, getProjectRoot honors it even from a subdir.
    // Use a *different* canonical root to prove the env-var wins.
    const overrideRoot = mkdtempSync(join(tmpdir(), 'cleo-agent-override-'));
    mkdirSync(join(overrideRoot, '.cleo'), { recursive: true });
    mkdirSync(join(overrideRoot, '.git'), { recursive: true });
    writeFileSync(
      join(overrideRoot, '.cleo', 'project-info.json'),
      JSON.stringify({ projectId: 'override' }),
    );
    process.env['CLEO_ROOT'] = overrideRoot;
    process.chdir(fixture.subDir);

    try {
      const run = getAgentSubRun('list');
      await run({ args: {}, rawArgs: [] });

      expect(captured.listRoot).toBe(overrideRoot);
      expect(captured.listRoot).not.toBe(fixture.rootDir);
      expect(captured.listRoot).not.toBe(fixture.subDir);
    } finally {
      delete process.env['CLEO_ROOT'];
      try {
        rmSync(overrideRoot, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });
});
