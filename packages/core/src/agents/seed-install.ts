/**
 * Idempotent seed-agent installer — T897 / T1239 / T1241.
 *
 * On `cleo init` (or first `cleo session start`), callers invoke
 * {@link ensureSeedAgentsInstalled} to materialise canonical `.cant` files for
 * the project. Two install paths are supported, selected at runtime:
 *
 *  1. **Meta-agent synthesis (T1239)** — when a project-context.json is
 *     present AND the caller provides an `AgentDispatcher` (typically the
 *     playbook runtime wiring), the installer delegates to the bundled
 *     `agent-architect` meta-agent so agents are customised against the
 *     project's tech-stack + conventions.
 *  2. **Static copy (legacy T897)** — when no dispatcher is supplied OR the
 *     meta-agent synthesis fails, the installer falls back to copying
 *     direct-usable `.cant` files from `packages/agents/starter-bundle/`
 *     (team.cant + agents/*.cant) into the user's global CANT agents
 *     directory (`~/.local/share/cleo/cant/agents/`). When
 *     `.cleo/project-context.json` is present on this path, template
 *     placeholders are resolved via the canonical variable-substitution SDK
 *     (T1238) before the file is written.
 *
 * Per D035 (v2026.4.111) the starter-bundle lives in `@cleocode/agents/`
 * (not `@cleocode/cleo-os/`); the installer routes through the
 * {@link resolveStarterBundle} SDK helper so the path is resolved via the
 * module graph rather than hardcoded.
 *
 * Both paths are idempotent: `~/.local/share/cleo/.seed-version` stores the
 * last-installed bundle version, and subsequent calls are no-ops unless the
 * packaged version has advanced past the marker.
 *
 * @module agents/seed-install
 * @task T897  — idempotent install
 * @task T1238 — variable substitution
 * @task T1239 — meta-agent refactor
 * @task T1241 — starter-bundle relocation (D035)
 * @epic T889 / T1232
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCleoGlobalCantAgentsDir, getCleoHome } from '../paths.js';
import { resolveStarterBundle } from './resolveStarterBundle.js';
import { loadProjectContext, substituteCantAgentBody } from './variable-substitution.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Marker file path that records the last installed seed bundle version.
 *
 * Written as a plain semver string (or CalVer `YYYY.M.patch`). Absent on a
 * fresh install — treated as `"0"` for comparison purposes.
 *
 * @task T897
 */
export const SEED_VERSION_MARKER_FILENAME = '.seed-version';

// ---------------------------------------------------------------------------
// Public API types
// ---------------------------------------------------------------------------

/**
 * Which code path produced an install result.
 *
 * @task T1239
 */
export type SeedInstallSource = 'meta-agent' | 'static-copy' | 'noop';

/**
 * Result returned by {@link ensureSeedAgentsInstalled}.
 *
 * @task T897 / T1239
 */
export interface SeedInstallResult {
  /** Agent slugs (filename sans `.cant`) that were newly written. */
  readonly installed: string[];
  /**
   * Agent slugs that were skipped because an on-disk file already existed
   * OR the stored version marker matched the bundle version.
   */
  readonly skipped: string[];
  /** Absolute path to the directory agents were installed into. */
  readonly destination: string;
  /**
   * Bundle version string written to the `.seed-version` marker after a
   * successful install. `null` when the install was a no-op (up-to-date).
   */
  readonly installedVersion: string | null;
  /** Which code path handled the install. */
  readonly source: SeedInstallSource;
  /**
   * Variables that were left unresolved during template substitution on the
   * static-copy path. Empty in meta-agent and no-op scenarios.
   */
  readonly unresolvedVariables: string[];
}

/**
 * Minimal agent-dispatcher shape consumed by {@link ensureSeedAgentsInstalled}
 * when meta-agent synthesis is available.
 *
 * Structurally compatible with `AgentDispatcher` exported from
 * `@cleocode/core/playbooks/agent-dispatcher`. Accepting the narrow shape here
 * avoids a hard import cycle and lets the CLI wire any dispatcher
 * implementation (core's or a custom one) without churn.
 *
 * @task T1239
 */
export interface SeedInstallDispatcher {
  dispatch(input: {
    runId: string;
    nodeId: string;
    agentId: string;
    taskId: string;
    context: Record<string, unknown>;
    iteration: number;
  }): Promise<{ status: 'success' | 'failure'; output: Record<string, unknown>; error?: string }>;
}

/**
 * Options accepted by {@link ensureSeedAgentsInstalled}.
 *
 * All fields are optional so existing call sites continue to work unchanged.
 * Supply `dispatcher` to opt into meta-agent synthesis; supply `projectRoot`
 * to enable template-variable substitution on the static-copy fallback.
 *
 * @task T1239
 */
export interface EnsureSeedAgentsInstalledOptions {
  /** Absolute path to the project root (for project-context.json lookup). */
  projectRoot?: string;
  /** Optional dispatcher that can execute the `agent-architect` meta-agent. */
  dispatcher?: SeedInstallDispatcher;
  /**
   * When `true`, skip the meta-agent path even when a dispatcher is provided.
   * Used by the legacy global postinstall hook where project context is
   * absent by definition.
   */
  skipMetaAgent?: boolean;
  /**
   * Override for the destination directory. Defaults to
   * {@link getCleoGlobalCantAgentsDir}. Tests can pin an isolated location.
   */
  destinationOverride?: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the canonical starter-bundle directory from the bundled
 * `@cleocode/agents` package.
 *
 * Delegates to the SDK helper {@link resolveStarterBundle} (T1241) so the
 * resolution strategy lives in a single place and both the installer and
 * any future consumer share the same graph traversal.
 *
 * Returns `null` when the starter-bundle directory cannot be located.
 *
 * @task T897 / T1241
 */
function resolveSeedDir(): string | null {
  return resolveStarterBundle();
}

/**
 * Read the bundle version from `@cleocode/agents/package.json`.
 *
 * Falls back to `"0"` when the package is unreachable so the comparison
 * logic can always proceed.
 *
 * @task T897
 */
function readBundleVersion(): string {
  try {
    const req = createRequire(import.meta.url);
    const pkgPath = req.resolve('@cleocode/agents/package.json');
    const raw = readFileSync(pkgPath, 'utf8');
    const parsed = JSON.parse(raw) as { version?: string };
    if (typeof parsed.version === 'string' && parsed.version.length > 0) {
      return parsed.version;
    }
  } catch {
    // unreachable — fall through
  }
  // Walk relative candidates when require.resolve fails
  const here = dirname(fileURLToPath(import.meta.url));
  const pkgCandidates = [
    join(here, '..', '..', '..', 'agents', 'package.json'),
    join(here, '..', '..', '..', '..', 'agents', 'package.json'),
  ];
  for (const p of pkgCandidates) {
    try {
      const raw = readFileSync(p, 'utf8');
      const parsed = JSON.parse(raw) as { version?: string };
      if (typeof parsed.version === 'string' && parsed.version.length > 0) {
        return parsed.version;
      }
    } catch {
      // try next
    }
  }
  return '0';
}

/**
 * Absolute path to the `.seed-version` marker file.
 *
 * Stored directly under `getCleoHome()` (e.g.
 * `~/.local/share/cleo/.seed-version`).
 *
 * @task T897
 */
function markerPath(): string {
  return join(getCleoHome(), SEED_VERSION_MARKER_FILENAME);
}

/**
 * Read the currently-stored seed version from the marker file.
 *
 * Returns `"0"` when the file is absent (first install) or unreadable.
 *
 * @task T897
 */
function readStoredVersion(): string {
  try {
    const content = readFileSync(markerPath(), 'utf8').trim();
    return content.length > 0 ? content : '0';
  } catch {
    return '0';
  }
}

/**
 * Produce the standard `skipped`-only result emitted when the marker matches
 * the bundle version (fast-path for `cleo init` idempotency).
 *
 * @task T1239
 */
function buildSkippedResult(destination: string): SeedInstallResult {
  let alreadyPresent: string[] = [];
  try {
    alreadyPresent = readdirSync(destination)
      .filter((f) => f.endsWith('.cant'))
      .map((f) => f.replace(/\.cant$/, ''));
  } catch {
    // directory may not exist yet if this is a weird state
  }
  return {
    installed: [],
    skipped: alreadyPresent,
    destination,
    installedVersion: null,
    source: 'noop',
    unresolvedVariables: [],
  };
}

// ---------------------------------------------------------------------------
// Meta-agent path
// ---------------------------------------------------------------------------

/**
 * Invoke the `agent-architect` meta-agent via the caller's dispatcher.
 *
 * Returns `null` when the dispatcher rejects the call — the main installer
 * then falls back to the static-copy path.
 *
 * @task T1239
 */
async function runMetaAgentSynthesis(args: {
  dispatcher: SeedInstallDispatcher;
  projectRoot: string;
  destination: string;
  bundleVersion: string;
}): Promise<SeedInstallResult | null> {
  const { dispatcher, projectRoot, destination, bundleVersion } = args;

  // Load project context — meta-agent path is a no-op when absent.
  const projectContext = loadProjectContext(projectRoot);
  if (!projectContext.loaded) {
    return null;
  }

  try {
    const result = await dispatcher.dispatch({
      runId: `seed-install-${Date.now()}`,
      nodeId: 'architect_agents',
      agentId: 'agent-architect',
      taskId: 'seed-install',
      context: {
        projectRoot,
        projectContext: projectContext.context,
        cantAgentsDir: destination,
        bundleVersion,
      },
      iteration: 1,
    });

    if (result.status === 'failure') {
      return null;
    }

    // Extract the list of emitted agents from dispatcher output. The
    // meta-agent contract (OUT-001) requires `agent-created:` lines in
    // stdout; we accept either `installed: string[]` or a full `agents`
    // array in the dispatcher output for flexibility.
    const rawInstalled = Array.isArray(result.output['installed'])
      ? (result.output['installed'] as unknown[])
      : Array.isArray(result.output['agents'])
        ? (result.output['agents'] as unknown[])
        : [];
    const installed: string[] = rawInstalled
      .filter((v): v is string => typeof v === 'string' && v.length > 0)
      .map((v) => v.replace(/\.cant$/, ''));

    // Write version marker atomically
    writeFileSync(markerPath(), bundleVersion, { encoding: 'utf8', mode: 0o644 });

    return {
      installed,
      skipped: [],
      destination,
      installedVersion: installed.length > 0 ? bundleVersion : null,
      source: 'meta-agent',
      unresolvedVariables: [],
    };
  } catch {
    // Dispatcher threw — fall back to static copy path.
    return null;
  }
}

// ---------------------------------------------------------------------------
// Static-copy path
// ---------------------------------------------------------------------------

/**
 * Enumerate every `.cant` file shipped by the starter-bundle.
 *
 * The starter-bundle layout (per D035) is:
 * ```
 * starter-bundle/
 *   team.cant
 *   agents/
 *     cleo-orchestrator.cant
 *     dev-lead.cant
 *     code-worker.cant
 *     docs-worker.cant
 * ```
 *
 * This helper returns `{ src, filename }` tuples so callers can preserve the
 * original basename when writing to the flat `.cleo/cant/agents/` target
 * without leaking the source sub-directory structure.
 *
 * @task T1241
 */
function enumerateStarterBundleCantFiles(
  seedDir: string,
): Array<{ src: string; filename: string }> {
  const tuples: Array<{ src: string; filename: string }> = [];

  // 1. Top-level team.cant (always present in a well-formed bundle).
  const teamSrc = join(seedDir, 'team.cant');
  if (existsSync(teamSrc)) {
    tuples.push({ src: teamSrc, filename: 'team.cant' });
  }

  // 2. agents/*.cant — persona files.
  const agentsDir = join(seedDir, 'agents');
  if (existsSync(agentsDir)) {
    try {
      const entries = readdirSync(agentsDir).filter((f) => f.endsWith('.cant'));
      for (const filename of entries) {
        tuples.push({ src: join(agentsDir, filename), filename });
      }
    } catch {
      // Best-effort: the caller will emit an empty result if the dir
      // cannot be read, matching prior behaviour.
    }
  }

  return tuples;
}

/**
 * Legacy static-copy path with optional template variable substitution.
 *
 * When `projectRoot` is supplied AND `.cleo/project-context.json` exists, each
 * `.cant` file is piped through {@link substituteCantAgentBody} before being
 * written to disk. The substitution is lenient — unresolved placeholders stay
 * as-is but are tallied in `unresolvedVariables` for operator awareness.
 *
 * Reads from `packages/agents/starter-bundle/` (per D035, v2026.4.111) —
 * the direct-usable install set, NOT the `{{var}}` templates shipped under
 * `packages/agents/seed-agents/` (those are meta-agent inputs).
 *
 * @task T897 / T1238 / T1241
 */
function runStaticCopy(args: {
  seedDir: string;
  destination: string;
  bundleVersion: string;
  projectRoot: string | undefined;
}): SeedInstallResult {
  const { seedDir, destination, bundleVersion, projectRoot } = args;

  // Ensure destination exists
  mkdirSync(destination, { recursive: true });

  const seeds = enumerateStarterBundleCantFiles(seedDir);
  const installed: string[] = [];
  const skipped: string[] = [];
  const unresolvedSet = new Set<string>();

  for (const { src, filename } of seeds) {
    const dst = join(destination, filename);
    const slug = filename.replace(/\.cant$/, '');

    if (existsSync(dst)) {
      skipped.push(slug);
      continue;
    }

    if (projectRoot !== undefined) {
      // Substitution path — read the template, resolve, write.
      try {
        const body = readFileSync(src, 'utf8');
        const substituted = substituteCantAgentBody(body, {
          projectRoot,
          env: process.env,
        });
        writeFileSync(dst, substituted.text, { encoding: 'utf8', mode: 0o644 });
        for (const name of substituted.missing) unresolvedSet.add(name);
        installed.push(slug);
        continue;
      } catch {
        // Fall through to plain copy on substitution errors.
      }
    }

    copyFileSync(src, dst);
    installed.push(slug);
  }

  // Write the marker atomically (write to tmp file, then rename is not
  // available in Node's synchronous fs API without extra work, so we
  // write directly — acceptable for a marker-only file).
  writeFileSync(markerPath(), bundleVersion, { encoding: 'utf8', mode: 0o644 });

  return {
    installed,
    skipped,
    destination,
    installedVersion: installed.length > 0 ? bundleVersion : null,
    source: 'static-copy',
    unresolvedVariables: Array.from(unresolvedSet).sort(),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Ensure the canonical seed agents are installed for the current project.
 *
 * Two code paths:
 *
 *  1. **Meta-agent synthesis** (preferred) — when `options.dispatcher` is set
 *     and `.cleo/project-context.json` exists, delegate to the bundled
 *     `agent-architect` meta-agent so agents are customised against the
 *     project's tech-stack, conventions, and testing framework.
 *  2. **Static copy with substitution** (fallback) — copy bundled
 *     `.cant` templates into the destination, resolving any
 *     `{{variable}}` placeholders against project context + environment.
 *     Guarantees backwards compatibility with the T897 behaviour.
 *
 * Idempotent: checks `~/.local/share/cleo/.seed-version` against the current
 * bundle version. When they match, every file is listed under `skipped` and no
 * I/O is performed. When the bundle version is newer, the meta-agent or static
 * path runs and the marker is updated.
 *
 * A file that already exists on disk (same name) is always skipped — partial
 * upgrades are therefore additive. Use `cleo agent install --global --force`
 * to overwrite individual agents.
 *
 * @param options - Optional meta-agent + project-root hints.
 * @returns A {@link SeedInstallResult} describing what was installed, what
 *          was skipped, the destination directory, and which source handled
 *          the call.
 *
 * @example
 * ```typescript
 * // Legacy call site — static copy only, no substitution.
 * const basic = await ensureSeedAgentsInstalled();
 *
 * // Project-aware — substitution resolves {{tech_stack}} etc.
 * const withVars = await ensureSeedAgentsInstalled({ projectRoot: process.cwd() });
 *
 * // Full meta-agent synthesis.
 * const synthesized = await ensureSeedAgentsInstalled({
 *   projectRoot: process.cwd(),
 *   dispatcher: myDispatcher,
 * });
 * ```
 *
 * @task T897 / T1238 / T1239
 */
export async function ensureSeedAgentsInstalled(
  options: EnsureSeedAgentsInstalledOptions = {},
): Promise<SeedInstallResult> {
  const destination = options.destinationOverride ?? getCleoGlobalCantAgentsDir();
  const bundleVersion = readBundleVersion();
  const storedVersion = readStoredVersion();

  // Fast-path: already up to date — collect current files as skipped
  if (storedVersion === bundleVersion && storedVersion !== '0') {
    return buildSkippedResult(destination);
  }

  const seedDir = resolveSeedDir();
  if (!seedDir) {
    // Seed dir not found — no-op, caller decides how to surface this
    return {
      installed: [],
      skipped: [],
      destination,
      installedVersion: null,
      source: 'noop',
      unresolvedVariables: [],
    };
  }

  // Meta-agent path (requires dispatcher + projectRoot with context file)
  if (
    options.dispatcher !== undefined &&
    options.projectRoot !== undefined &&
    options.skipMetaAgent !== true
  ) {
    mkdirSync(destination, { recursive: true });
    const metaResult = await runMetaAgentSynthesis({
      dispatcher: options.dispatcher,
      projectRoot: options.projectRoot,
      destination,
      bundleVersion,
    });
    if (metaResult !== null) {
      return metaResult;
    }
    // fall through to static copy on meta-agent failure or missing context
  }

  // Legacy static-copy path (with optional substitution when projectRoot set)
  return runStaticCopy({
    seedDir,
    destination,
    bundleVersion,
    projectRoot: options.projectRoot,
  });
}

// ---------------------------------------------------------------------------
// Legacy-path reroute migration (T1241 — D035)
// ---------------------------------------------------------------------------

/**
 * Shape of the minimal `DatabaseSync` surface used by
 * {@link rerouteLegacyStarterBundlePaths}. Structurally compatible with
 * `node:sqlite`'s `DatabaseSync`; kept narrow here to avoid importing the
 * runtime type at module-load time.
 *
 * @task T1241
 */
export interface RerouteLegacyDb {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): { changes?: number | bigint };
  };
}

/**
 * Agents-row subset the reroute migration cares about.
 *
 * @task T1241
 */
interface LegacyStarterBundleAgentRow {
  id: string;
  agent_id: string;
  cant_path: string | null;
}

/**
 * Legacy filesystem substring that identifies a stale registry row pointing
 * at the pre-v2026.4.111 `packages/cleo-os/starter-bundle/` location.
 *
 * @task T1241
 */
const LEGACY_CLEO_OS_STARTER_BUNDLE_SUBSTR = 'cleo-os/starter-bundle';

/**
 * Result envelope returned by {@link rerouteLegacyStarterBundlePaths}.
 *
 * @task T1241
 */
export interface RerouteLegacyStarterBundleResult {
  /** Number of rows whose `cant_path` was rewritten. */
  readonly rewrittenRows: number;
  /**
   * Agents that were rewritten. Each entry carries the agent id and the
   * old + new on-disk paths for audit.
   */
  readonly agents: ReadonlyArray<{
    readonly agentId: string;
    readonly oldPath: string;
    readonly newPath: string;
  }>;
  /**
   * Rows that matched the legacy substring but whose rewrite target could
   * not be resolved (e.g. `@cleocode/agents` unreachable from this process).
   * Callers should surface these as warnings.
   */
  readonly skippedRows: ReadonlyArray<{
    readonly agentId: string;
    readonly oldPath: string;
    readonly reason: string;
  }>;
}

/**
 * One-shot registry migration that reroutes `agents.cant_path` rows pointing
 * at the pre-v2026.4.111 `packages/cleo-os/starter-bundle/` location to the
 * new `packages/agents/starter-bundle/` location (per D035).
 *
 * Strategy:
 *
 *  1. Select every row whose `cant_path` contains the legacy substring
 *     `cleo-os/starter-bundle`.
 *  2. For each row, locate the matching `.cant` file under the new
 *     `packages/agents/starter-bundle/` tree by preserving the sub-path
 *     suffix after `starter-bundle/`.
 *  3. Rewrite the row's `cant_path` via a `UPDATE … WHERE id = ?`
 *     statement so the doctor walk sees the new canonical path.
 *
 * Safe to call repeatedly: after the first run no rows match the legacy
 * substring so subsequent calls are no-ops.
 *
 * Invoked by `cleo agent doctor` on first run after upgrade (wired through
 * the doctor entry point) so operators are not required to trigger it
 * manually.
 *
 * @param db - Open handle to the global `signaldock.db`.
 * @returns Summary of rewritten + skipped rows.
 * @task T1241 / D035
 */
export function rerouteLegacyStarterBundlePaths(
  db: RerouteLegacyDb,
): RerouteLegacyStarterBundleResult {
  const rows = db
    .prepare('SELECT id, agent_id, cant_path FROM agents WHERE cant_path LIKE ?')
    .all(`%${LEGACY_CLEO_OS_STARTER_BUNDLE_SUBSTR}%`) as LegacyStarterBundleAgentRow[];

  const newBundleRoot = resolveStarterBundle();
  const rewritten: Array<{ agentId: string; oldPath: string; newPath: string }> = [];
  const skipped: Array<{ agentId: string; oldPath: string; reason: string }> = [];

  if (rows.length === 0) {
    return { rewrittenRows: 0, agents: [], skippedRows: [] };
  }

  if (newBundleRoot === null) {
    for (const row of rows) {
      if (row.cant_path !== null) {
        skipped.push({
          agentId: row.agent_id,
          oldPath: row.cant_path,
          reason: '@cleocode/agents starter-bundle not resolvable from current process',
        });
      }
    }
    return { rewrittenRows: 0, agents: [], skippedRows: skipped };
  }

  const update = db.prepare('UPDATE agents SET cant_path = ? WHERE id = ?');

  for (const row of rows) {
    const oldPath = row.cant_path;
    if (oldPath === null) continue;

    // Compute the suffix after `starter-bundle/` (e.g. `agents/cleo-orchestrator.cant`
    // or `team.cant`). Falls back to the basename when the substring is
    // not found (defensive — shouldn't happen after the LIKE query).
    const markerIdx = oldPath.indexOf('starter-bundle/');
    const suffix =
      markerIdx >= 0
        ? oldPath.slice(markerIdx + 'starter-bundle/'.length)
        : (oldPath.split(/[/\\]/).pop() ?? oldPath);

    const newPath = join(newBundleRoot, suffix);

    if (!existsSync(newPath)) {
      skipped.push({
        agentId: row.agent_id,
        oldPath,
        reason: `target file not present at new location: ${newPath}`,
      });
      continue;
    }

    update.run(newPath, row.id);
    rewritten.push({ agentId: row.agent_id, oldPath, newPath });
  }

  return {
    rewrittenRows: rewritten.length,
    agents: rewritten,
    skippedRows: skipped,
  };
}
