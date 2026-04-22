/**
 * Agent dispatcher — 5-tier resolution wrapper for the playbook runtime.
 *
 * This module ships the canonical `AgentDispatcher` implementation consumed by
 * `@cleocode/playbooks` runtime. The runtime declares a structural
 * `AgentDispatcher` interface but injects it purely by dependency; the
 * implementation lives here in `@cleocode/core` so the playbook package keeps
 * its zero-dependency-on-store invariant intact.
 *
 * Resolution precedence (highest wins):
 *
 *   1. `meta`     — agents shipped by `@cleocode/agents/meta/`
 *                   (meta-agents: agent-architect, skill-architect, ...)
 *   2. `project`  — `<projectRoot>/.cleo/cant/agents/<id>.cant`
 *                   (registry rows tagged `tier='project'`)
 *   3. `global`   — `~/.local/share/cleo/cant/agents/<id>.cant`
 *                   (registry rows tagged `tier='global'`)
 *   4. `packaged` — `@cleocode/agents/seed-agents/<id>.cant`
 *                   (registry rows tagged `tier='packaged'`)
 *   5. `fallback` — synthesised envelope when the bundled seed file exists but
 *                   no registry row has been written yet
 *
 * Tiers 2-5 delegate to the existing `resolveAgent()` helper in
 * `@cleocode/core/store/agent-resolver`. Tier 1 (`meta`) is added here without
 * mutating that function — meta-agents are filesystem-only and need no registry
 * row, so a dedicated lookup walks the bundled `packages/agents/meta/`
 * directory first before the standard resolver runs.
 *
 * The dispatcher does NOT invoke an LLM or spawn a subprocess — it produces a
 * `AgentDispatchResult` envelope with the resolved agent metadata and lets the
 * playbook runtime decide how to consume it. Call sites that need actual LLM
 * spawning wire a different dispatcher (e.g. the CLI's orchestrate engine).
 *
 * @module playbooks/agent-dispatcher
 * @task T1239 — meta-agent infrastructure (epic T1232)
 * @see ADR-055 — agents architecture & meta-agents
 */

import { createHash } from 'node:crypto';
import { accessSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve as resolvePath } from 'node:path';
import type { DatabaseSync as _DatabaseSyncType } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import type { ResolvedAgent } from '@cleocode/contracts';
import { AgentNotFoundError, resolveAgent } from '../store/agent-resolver.js';

// ---------------------------------------------------------------------------
// node:sqlite interop
// ---------------------------------------------------------------------------

const _dispatcherRequire = createRequire(import.meta.url);
type DatabaseSync = _DatabaseSyncType;

// ---------------------------------------------------------------------------
// Dispatcher contract — structurally compatible with
// @cleocode/playbooks::AgentDispatcher
// ---------------------------------------------------------------------------

/**
 * Tier id for the meta-agent lookup added on top of the 4-tier resolver.
 *
 * Exported as a constant so callers (tests, CLI audit surfaces) can assert
 * against the canonical string instead of hard-coding `'meta'`.
 *
 * @task T1239
 */
export const AGENT_TIER_META = 'meta' as const;

/**
 * Dispatch input envelope. Shape mirrors `AgentDispatchInput` exported by
 * `@cleocode/playbooks/runtime` so a core dispatcher can be passed straight
 * into `executePlaybook()` without a wrapper.
 *
 * @task T1239
 */
export interface DispatchContext {
  /** Playbook run identifier (FK into `playbook_runs.run_id`). */
  runId: string;
  /** Node identifier within the run graph. */
  nodeId: string;
  /** Agent identity resolved from `node.agent` (or `node.skill`). */
  agentId: string;
  /** Task identifier lifted from `context.taskId`, falls back to `runId`. */
  taskId: string;
  /** Snapshot of accumulated bindings at dispatch time. */
  context: Record<string, unknown>;
  /** 1-based iteration counter for this specific node. */
  iteration: number;
}

/**
 * Dispatch result envelope. Shape mirrors `AgentDispatchResult` from the
 * playbook runtime for structural compatibility.
 *
 * @task T1239
 */
export interface DispatchResult {
  status: 'success' | 'failure';
  /** Key-value pairs merged into the run context on success. */
  output: Record<string, unknown>;
  /** Human-readable failure reason on `status === 'failure'`. */
  error?: string;
}

/**
 * Canonical core dispatcher interface. Structurally matches the playbook
 * runtime's `AgentDispatcher` so `new CoreAgentDispatcher(...)` can be passed
 * directly as `dispatcher` in `executePlaybook({ dispatcher, ... })`.
 *
 * @task T1239
 */
export interface AgentDispatcher {
  /** Execute a single `agentic` node; return a success/failure envelope. */
  dispatch(context: DispatchContext): Promise<DispatchResult>;
}

// ---------------------------------------------------------------------------
// Meta-tier resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the directory holding `@cleocode/agents/meta/` for the current
 * install layout.
 *
 * Resolution order (first hit wins):
 *  1. `require.resolve('@cleocode/agents/package.json')` → sibling workspace.
 *  2. Walk a set of relative-path candidates from this file's location.
 *
 * Returns `null` when the meta directory cannot be located (e.g. when
 * `@cleocode/agents` has not shipped a `meta/` subtree yet).
 *
 * @task T1239
 */
function resolveMetaAgentsDir(): string | null {
  try {
    const agentsPkg = _dispatcherRequire.resolve('@cleocode/agents/package.json');
    const candidate = join(dirname(agentsPkg), 'meta');
    if (pathExists(candidate)) return candidate;
  } catch {
    // fall through to relative candidates
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // packages/core/src/playbooks -> packages/agents/meta
    resolvePath(here, '..', '..', '..', 'agents', 'meta'),
    // packages/core/dist/playbooks -> packages/agents/meta
    resolvePath(here, '..', '..', '..', '..', 'agents', 'meta'),
    // node_modules/@cleocode/core/dist/playbooks -> ../agents/meta
    resolvePath(here, '..', '..', '..', '..', '..', 'agents', 'meta'),
  ];
  return candidates.find((p) => pathExists(p)) ?? null;
}

/**
 * Attempt to resolve `agentId` in the meta-tier (filesystem-only).
 *
 * Meta-agents live in `@cleocode/agents/meta/` and are not required to have a
 * registry row — they are first-class bundled artefacts. This helper reads the
 * `.cant` file directly, hashes it, and synthesises a `ResolvedAgent` envelope
 * tagged `tier='fallback'` with `source='meta'` so consumers can tell the
 * origin apart from the 4-tier resolver's `fallback` outputs.
 *
 * Returns `null` when no meta-tier file exists — the caller should then
 * delegate to the standard `resolveAgent()` helper.
 *
 * @param agentId - Business id of the agent to resolve.
 * @param overrideDir - Optional override for the meta-agents directory
 *   (used by tests to pin a fixture location).
 * @returns Resolved envelope or `null` when the meta-tier misses.
 * @task T1239
 */
export function resolveMetaAgent(agentId: string, overrideDir?: string): ResolvedAgent | null {
  const metaDir = overrideDir ?? resolveMetaAgentsDir();
  if (metaDir === null) return null;
  const path = join(metaDir, `${agentId}.cant`);
  if (!pathExists(path)) return null;
  const bytes = readFileSync(path);
  const hash = createHash('sha256').update(bytes).digest('hex');
  return {
    agentId,
    tier: 'fallback',
    cantPath: path,
    cantSha256: hash,
    canSpawn: true,
    orchLevel: 2,
    reportsTo: null,
    skills: [],
    source: 'fallback',
    aliasApplied: false,
  };
}

// ---------------------------------------------------------------------------
// Core dispatcher implementation
// ---------------------------------------------------------------------------

/**
 * Options accepted by {@link CoreAgentDispatcher}.
 *
 * @task T1239
 */
export interface CoreAgentDispatcherOptions {
  /** Open handle to global `signaldock.db`. Required. */
  db: DatabaseSync;
  /** Absolute project root used by the `project` tier lookup. */
  projectRoot?: string;
  /** Override for the meta-agents directory (tests only). */
  metaDir?: string;
  /** Override for the bundled seed-agents directory (tests only). */
  packagedSeedDir?: string;
  /**
   * Override for the universal-base `.cant` file used by the 5th-tier
   * fallback in `resolveAgent`. Tests pin this to a known-missing path so
   * they can still exercise the "no tier resolves" failure branch.
   *
   * @task T1241
   */
  universalBasePath?: string;
  /**
   * Optional hook invoked after a successful resolution. The playbook runtime
   * uses this to emit a `dispatcher.resolve` event for audit trails.
   */
  onResolve?: (agent: ResolvedAgent, context: DispatchContext) => void;
  /**
   * Optional executor that performs the actual spawn once an agent has been
   * resolved. When unset, the dispatcher returns a success envelope with the
   * resolved-agent metadata in `output.agent` — suitable for tests and for
   * playbook runs that only need to verify dispatchability.
   */
  executor?: (agent: ResolvedAgent, context: DispatchContext) => Promise<DispatchResult>;
}

/**
 * 5-tier agent dispatcher for the playbook runtime.
 *
 * Wraps `@cleocode/core/store/agent-resolver.resolveAgent` with a
 * meta-tier lookup that runs first. Never mutates the wrapped resolver —
 * cascades via `null` return instead.
 *
 * @example
 * ```ts
 * const dispatcher = new CoreAgentDispatcher({ db, projectRoot: process.cwd() });
 * await executePlaybook({ dispatcher, ... });
 * ```
 *
 * @task T1239
 */
export class CoreAgentDispatcher implements AgentDispatcher {
  private readonly db: DatabaseSync;
  private readonly projectRoot: string | undefined;
  private readonly metaDir: string | undefined;
  private readonly packagedSeedDir: string | undefined;
  private readonly universalBasePath: string | undefined;
  private readonly onResolve: CoreAgentDispatcherOptions['onResolve'];
  private readonly executor: CoreAgentDispatcherOptions['executor'];

  constructor(opts: CoreAgentDispatcherOptions) {
    this.db = opts.db;
    this.projectRoot = opts.projectRoot;
    this.metaDir = opts.metaDir;
    this.packagedSeedDir = opts.packagedSeedDir;
    this.universalBasePath = opts.universalBasePath;
    this.onResolve = opts.onResolve;
    this.executor = opts.executor;
  }

  /**
   * Resolve the agent via the 5-tier cascade and optionally execute it.
   *
   * Returns `status: 'failure'` (rather than throwing) when the agent id is
   * absent from every tier — this keeps the playbook runtime's retry /
   * escalation semantics intact.
   *
   * @param context - Dispatch input from the playbook runtime.
   * @returns Dispatch result envelope.
   */
  public async dispatch(context: DispatchContext): Promise<DispatchResult> {
    const resolved = this.resolve(context.agentId);
    if (resolved === null) {
      return {
        status: 'failure',
        output: {},
        error: `agent "${context.agentId}" not found in any tier (meta, project, global, packaged, fallback)`,
      };
    }

    this.onResolve?.(resolved, context);

    if (this.executor) {
      try {
        return await this.executor(resolved, context);
      } catch (err) {
        return {
          status: 'failure',
          output: {},
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }

    // Default executor — report the resolved agent metadata so tests and
    // dry-run playbook traversals can assert against a deterministic output.
    // `tier` here is the 5-tier classification (meta > project > ...) while
    // `source` mirrors the underlying ResolvedAgent.source.
    const tierLabel = this.resolveTier(context.agentId) ?? resolved.source;
    return {
      status: 'success',
      output: {
        agent: {
          agentId: resolved.agentId,
          tier: tierLabel,
          source: resolved.source,
          cantPath: resolved.cantPath,
          cantSha256: resolved.cantSha256,
          canSpawn: resolved.canSpawn,
        },
      },
    };
  }

  /**
   * Resolve an agent id against the 5-tier cascade without executing it.
   *
   * Useful for callers that want to audit availability before dispatch
   * (e.g. `cleo agent doctor`).
   *
   * @param agentId - Business id to resolve.
   * @returns The resolved envelope, or `null` when every tier misses.
   */
  public resolve(agentId: string): ResolvedAgent | null {
    // Tier 1 — meta (filesystem-only, bypasses registry). The envelope keeps
    // `tier: 'fallback'` to stay compatible with the ResolvedAgent contract;
    // meta-tier consumers read the separate {@link resolveTier} output below
    // or the dispatcher's {@link DispatchResult.output.agent.tier} field.
    const meta = resolveMetaAgent(agentId, this.metaDir);
    if (meta !== null) {
      return meta;
    }

    // Tiers 2-5 — delegate to the standard resolver
    try {
      return resolveAgent(this.db, agentId, this.buildResolveOptions());
    } catch (err) {
      if (err instanceof AgentNotFoundError) {
        return null;
      }
      throw err;
    }
  }

  /**
   * Assemble the {@link import('../store/agent-resolver.js').ResolveAgentOptions}
   * payload used by the dispatcher's lookup calls. Keeping the assembly in
   * one place ensures `resolve()` and `resolveTier()` stay in lock-step and
   * the new-in-T1241 `universalBasePath` override is never silently dropped.
   *
   * @task T1241
   */
  private buildResolveOptions(): {
    projectRoot?: string;
    packagedSeedDir?: string;
    universalBasePath?: string;
  } {
    const opts: { projectRoot?: string; packagedSeedDir?: string; universalBasePath?: string } = {};
    if (this.projectRoot !== undefined) opts.projectRoot = this.projectRoot;
    if (this.packagedSeedDir !== undefined) opts.packagedSeedDir = this.packagedSeedDir;
    if (this.universalBasePath !== undefined) opts.universalBasePath = this.universalBasePath;
    return opts;
  }

  /**
   * Classify which tier bucket produced `agentId`.
   *
   * Unlike {@link resolve}, this helper reports the logical tier
   * (`'meta' | 'project' | 'global' | 'packaged' | 'fallback' | 'universal'`)
   * rather than the `AgentTier` enum baked into `ResolvedAgent`. Useful for
   * dispatch telemetry and for tests that need to assert meta-tier was
   * consulted. The `'universal'` tier was added in v2026.4.111 (T1241) as
   * the 5th fallback tier in the base resolver.
   *
   * @param agentId - Business id to classify.
   * @returns Tier label, or `null` when no tier resolves.
   */
  public resolveTier(
    agentId: string,
  ): typeof AGENT_TIER_META | 'project' | 'global' | 'packaged' | 'fallback' | 'universal' | null {
    if (resolveMetaAgent(agentId, this.metaDir) !== null) return AGENT_TIER_META;
    try {
      const resolved = resolveAgent(this.db, agentId, this.buildResolveOptions());
      return resolved.source;
    } catch (err) {
      if (err instanceof AgentNotFoundError) return null;
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Filesystem helpers (private)
// ---------------------------------------------------------------------------

/**
 * Test whether a path exists on disk without throwing.
 *
 * @param path - Absolute path to check.
 * @returns `true` when the path is reachable, `false` otherwise.
 */
function pathExists(path: string): boolean {
  try {
    accessSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Factory helper — create a {@link CoreAgentDispatcher} from the simplest
 * possible config. Prefer this over constructing directly when you only have
 * a database handle.
 *
 * @param db - Open `signaldock.db` handle.
 * @param projectRoot - Optional project root.
 * @returns A ready-to-dispatch instance.
 * @task T1239
 */
export function createAgentDispatcher(db: DatabaseSync, projectRoot?: string): CoreAgentDispatcher {
  return new CoreAgentDispatcher(projectRoot !== undefined ? { db, projectRoot } : { db });
}
