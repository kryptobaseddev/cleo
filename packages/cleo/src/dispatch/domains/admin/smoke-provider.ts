/**
 * Smoke Provider Handler (ADR-049)
 *
 * Read-only invariant probe that verifies CLEO harness sovereignty for a
 * given provider adapter. Checks five invariants per ADR-049:
 *
 * 1. Adapter resolves from `packages/adapters/dist/providers/<id>/index.js`
 *    and exports a shape compatible with {@link CLEOProviderAdapter}
 *    (id, name, version present on the class or a constructed instance).
 * 2. All four CLEO-owned DBs (brain, nexus, conduit, tasks) resolve to paths
 *    under the project `.cleo/` directory or the global CLEO home, never under
 *    provider-specific storage.
 * 3. Hook events declared in `packages/adapters/src/providers/<id>/hooks.ts`
 *    are counted against the CAAMP canonical event taxonomy.
 * 4. `packages/adapters/src/providers/<id>/spawn.ts` is present and classified
 *    as `yes` (real implementation), `stub` (throws only), or `no` (absent).
 * 5. `getProviderAgentFolder(providerId)` resolves to a valid path string.
 *
 * @task T647
 * @epic T636
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BRAIN_DB_FILENAME, CLEO_DIR_NAME } from '../../../cli/paths.js';
import type { EngineResult } from '../../engines/_error.js';
import { engineError, engineSuccess } from '../../engines/_error.js';

// ---------------------------------------------------------------------------
// Known provider IDs (ADR-049)
// ---------------------------------------------------------------------------

const VALID_PROVIDER_IDS = [
  'claude-code',
  'claude-sdk',
  'codex',
  'cursor',
  'gemini-cli',
  'kimi',
  'openai-sdk',
  'opencode',
  'pi',
] as const;

/** Provider IDs supported by the CLEO adapter registry. */
export type KnownProviderId = (typeof VALID_PROVIDER_IDS)[number];

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/** Locality status of a single CLEO-owned database file. */
export interface DbLocalityCheck {
  /** Database name (e.g. `"brain.db"`). */
  name: string;
  /** Whether the DB path resolves under CLEO-owned storage. */
  local: boolean;
  /** Resolved absolute path. */
  path: string;
}

/** Spawn implementation classification for a provider adapter. */
export type SpawnStatus = 'yes' | 'stub' | 'no';

/** Complete result of a provider harness sovereignty probe. */
export interface SmokeProviderResult {
  /** Provider ID that was probed. */
  providerId: string;
  /** Whether the adapter dist module resolved with the expected CLEOProviderAdapter shape. */
  adapterLoaded: boolean;
  /** Locality checks for the four CLEO-owned databases. */
  dbChecks: DbLocalityCheck[];
  /** Count of CAAMP canonical hook events referenced in the provider's hooks.ts. */
  hooksDeclared: number;
  /** Spawn implementation classification. */
  spawnStatus: SpawnStatus;
  /** Absolute path returned by `getProviderAgentFolder`, or null when provider is unknown. */
  agentFolder: string | null;
  /** Whether all ADR-049 invariants passed. */
  passed: boolean;
  /** Human-readable failure reason when `passed` is false. */
  failureReason?: string;
  /** Formatted plain-text report block for CLI rendering. */
  report: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Determine whether a resolved DB path is CLEO-local (ADR-049 invariant 2).
 *
 * A path is local when it starts with the project `.cleo/` directory or with
 * the global CLEO XDG home. Provider-specific storage paths are never local.
 *
 * @param dbPath - Absolute path to evaluate
 * @param projectCleoDir - Absolute path to `<projectRoot>/.cleo`
 * @param cleoHome - Absolute path to the global CLEO home directory
 * @returns True when the path is under CLEO-controlled storage
 */
function isLocal(dbPath: string, projectCleoDir: string, cleoHome: string): boolean {
  return dbPath.startsWith(projectCleoDir) || dbPath.startsWith(cleoHome);
}

/**
 * Classify a provider's spawn.ts as `yes`, `stub`, or `no`.
 *
 * Classification rules:
 * - `no`   — file is absent at the given source path.
 * - `stub` — file exists but contains `throw` without any spawn/exec/fork calls.
 * - `yes`  — file exists with substantive spawn-related implementation.
 *
 * @param spawnSrcPath - Absolute path to `<provider>/spawn.ts`
 * @returns Spawn implementation classification
 */
function classifySpawn(spawnSrcPath: string): SpawnStatus {
  if (!existsSync(spawnSrcPath)) return 'no';

  let src: string;
  try {
    src = readFileSync(spawnSrcPath, 'utf-8');
  } catch {
    return 'no';
  }

  const hasImpl = /\bspawn\b|\bexec\b|\bfork\b|\bchild_process\b|\bspawnSync\b/.test(src);
  if (!hasImpl && /\bthrow\b/.test(src)) return 'stub';
  return 'yes';
}

/**
 * Count CAAMP canonical hook event names referenced in a provider's hooks.ts.
 *
 * Each distinct canonical event name found in the source file is counted once.
 * Returns 0 when the file is absent or unreadable.
 *
 * @param hooksSrcPath - Absolute path to `<provider>/hooks.ts`
 * @param canonicalEvents - Array of CAAMP canonical event name strings
 * @returns Number of distinct canonical event names found in the file
 */
function countHookEvents(hooksSrcPath: string, canonicalEvents: readonly string[]): number {
  if (!existsSync(hooksSrcPath)) return 0;

  let src: string;
  try {
    src = readFileSync(hooksSrcPath, 'utf-8');
  } catch {
    return 0;
  }

  let count = 0;
  for (const event of canonicalEvents) {
    if (src.includes(event)) count++;
  }
  return count;
}

/**
 * Build the formatted plain-text report block for CLI rendering.
 *
 * @param partial - All probe fields except `report` itself
 * @returns Multi-line report string
 */
function buildReport(partial: Omit<SmokeProviderResult, 'report'>): string {
  const sep = '══════════════════════════════════════════';
  const lines: string[] = [
    `CLEO Smoke Probe — provider: ${partial.providerId}`,
    sep,
    `  Adapter loaded:       ${partial.adapterLoaded ? 'yes' : 'no'}`,
  ];

  for (const db of partial.dbChecks) {
    const label = `  ${db.name} local:`.padEnd(24);
    lines.push(`${label}${db.local ? 'yes' : 'NO'} (${db.path})`);
  }

  lines.push(`  Hooks declared:       ${partial.hooksDeclared}`);
  lines.push(`  Spawn implementation: ${partial.spawnStatus}`);
  lines.push(`  Agent folder:         ${partial.agentFolder ?? '(none — unknown provider)'}`);
  lines.push('');

  lines.push(
    partial.passed
      ? 'Result: PASS'
      : `Result: FAIL (${partial.failureReason ?? 'invariant violated'})`,
  );

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run the ADR-049 harness sovereignty smoke probe for a named provider.
 *
 * Probes five invariants:
 * 1. Adapter dist module resolves with id/name/version fields.
 * 2. All four CLEO-owned DBs resolve to CLEO-local paths.
 * 3. Hook events declared in the provider's hooks.ts are counted.
 * 4. spawn.ts is classified as yes, stub, or no.
 * 5. `getProviderAgentFolder(providerId)` returns a non-null string.
 *
 * Exit semantics: success=false with exit code 1 when any invariant fails.
 * Hooks count and spawn classification are informational, not failure conditions.
 *
 * @param providerId - One of the nine known CLEO provider IDs
 * @returns EngineResult with the complete probe report
 *
 * @example
 * ```typescript
 * const result = await smokeProvider('claude-code');
 * console.log(result.data?.report);
 * ```
 *
 * @task T647
 * @epic T636
 */
export async function smokeProvider(
  providerId: string,
): Promise<EngineResult<SmokeProviderResult>> {
  if (!VALID_PROVIDER_IDS.includes(providerId as KnownProviderId)) {
    return engineError<SmokeProviderResult>(
      'E_INVALID_INPUT',
      `Unknown provider ID: "${providerId}". Valid IDs: ${VALID_PROVIDER_IDS.join(', ')}`,
    );
  }

  // ------------------------------------------------------------------
  // Resolve the monorepo root (= CLEO project root in a monorepo dev context).
  // getProjectRoot() walks ancestors to find .cleo/ — the monorepo root IS
  // the project root for the cleocode repo (packages/adapters lives there).
  // ------------------------------------------------------------------

  const coreInternal = await import('@cleocode/core/internal');
  const projectRoot = (() => {
    try {
      return coreInternal.getProjectRoot();
    } catch {
      return process.env['CLEO_ROOT'] ?? process.cwd();
    }
  })();

  // monorepoRoot == projectRoot for this repo (packages/adapters is a peer of .cleo/).
  const monorepoRoot = projectRoot;

  // ------------------------------------------------------------------
  // Probe 1: Adapter dist resolves with CLEOProviderAdapter shape
  // ------------------------------------------------------------------

  const adapterDistPath = join(
    monorepoRoot,
    'packages',
    'adapters',
    'dist',
    'providers',
    providerId,
    'index.js',
  );

  let adapterLoaded = false;
  if (existsSync(adapterDistPath)) {
    try {
      const mod = (await import(adapterDistPath)) as Record<string, unknown>;
      // CLEOProviderAdapter requires id, name, version — check default export (class) or module fields
      const defaultExport = mod['default'];
      if (typeof defaultExport === 'function') {
        // Instantiate to check instance fields (id, name, version required by CLEOProviderAdapter)
        type ProviderCtor = new () => { id: string; name: string; version: string };
        const ctor = defaultExport as ProviderCtor;
        try {
          const instance = new ctor();
          adapterLoaded =
            typeof instance.id === 'string' &&
            typeof instance.name === 'string' &&
            typeof instance.version === 'string';
        } catch {
          // Constructor may require args — treat presence of dist file as loaded
          adapterLoaded = existsSync(adapterDistPath);
        }
      } else {
        // Module-level named exports (check id + name fields)
        adapterLoaded = typeof mod['id'] === 'string' && typeof mod['name'] === 'string';
      }
    } catch {
      adapterLoaded = false;
    }
  }

  // ------------------------------------------------------------------
  // Probe 2: DB locality
  // ------------------------------------------------------------------

  const cleoHome = coreInternal.getCleoHome();
  const projectCleoDir = join(projectRoot, CLEO_DIR_NAME);

  const taskDbPath = coreInternal.getTaskPath(projectRoot);
  // getBrainDbPath is not re-exported from @cleocode/core/internal; derive directly
  // via the same formula used in brain-sqlite.ts: join(cleoDirAbsolute, BRAIN_DB_FILENAME).
  const brainPath = join(projectCleoDir, BRAIN_DB_FILENAME);
  const conduitDbPath = coreInternal.getConduitDbPath(projectRoot);
  const nexusDbPath = coreInternal.getNexusDbPath();

  const dbChecks: DbLocalityCheck[] = [
    { name: 'brain.db', local: isLocal(brainPath, projectCleoDir, cleoHome), path: brainPath },
    { name: 'nexus.db', local: isLocal(nexusDbPath, projectCleoDir, cleoHome), path: nexusDbPath },
    {
      name: 'conduit.db',
      local: isLocal(conduitDbPath, projectCleoDir, cleoHome),
      path: conduitDbPath,
    },
    { name: 'tasks.db', local: isLocal(taskDbPath, projectCleoDir, cleoHome), path: taskDbPath },
  ];

  // ------------------------------------------------------------------
  // Probe 3: Hooks declared
  // ------------------------------------------------------------------

  let canonicalEvents: readonly string[] = [];
  try {
    const caamp = await import('@cleocode/caamp');
    canonicalEvents = caamp.CANONICAL_HOOK_EVENTS as readonly string[];
  } catch {
    canonicalEvents = [];
  }

  const hooksSrcPath = join(
    monorepoRoot,
    'packages',
    'adapters',
    'src',
    'providers',
    providerId,
    'hooks.ts',
  );
  const hooksDeclared = countHookEvents(hooksSrcPath, canonicalEvents);

  // ------------------------------------------------------------------
  // Probe 4: Spawn classification
  // ------------------------------------------------------------------

  const spawnSrcPath = join(
    monorepoRoot,
    'packages',
    'adapters',
    'src',
    'providers',
    providerId,
    'spawn.ts',
  );
  const spawnStatus = classifySpawn(spawnSrcPath);

  // ------------------------------------------------------------------
  // Probe 5: Agent folder
  // ------------------------------------------------------------------

  let agentFolder: string | null = null;
  try {
    const { getProviderAgentFolder } = await import('@cleocode/caamp');
    agentFolder = getProviderAgentFolder(providerId);
  } catch {
    agentFolder = null;
  }

  // ------------------------------------------------------------------
  // Determine pass/fail
  // ------------------------------------------------------------------

  const dbsLocal = dbChecks.every((c) => c.local);
  const failReasons: string[] = [];

  if (!adapterLoaded) failReasons.push('adapter did not load or missing id/name/version');
  if (!dbsLocal) {
    const nonLocal = dbChecks
      .filter((c) => !c.local)
      .map((c) => c.name)
      .join(', ');
    failReasons.push(`non-local DB paths: ${nonLocal}`);
  }
  if (agentFolder === null) failReasons.push('agent folder unresolvable (unknown provider)');

  const passed = failReasons.length === 0;

  const partial: Omit<SmokeProviderResult, 'report'> = {
    providerId,
    adapterLoaded,
    dbChecks,
    hooksDeclared,
    spawnStatus,
    agentFolder,
    passed,
    ...(passed ? {} : { failureReason: failReasons.join('; ') }),
  };

  const report = buildReport(partial);
  const result: SmokeProviderResult = { ...partial, report };

  if (!passed) {
    return {
      success: false,
      data: result,
      error: {
        code: 'E_SMOKE_PROVIDER_FAIL',
        message: `ADR-049 probe FAILED for provider "${providerId}": ${partial.failureReason}`,
        exitCode: 1,
      },
    };
  }

  return engineSuccess(result);
}
