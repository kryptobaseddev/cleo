/**
 * SDK helper — invoke a CLEO meta-agent from the `@cleocode/agents/meta/` directory.
 *
 * Meta-agents (agent-architect, playbook-architect) synthesize project-specific
 * artifacts from templates + context. This module provides the invocation shim
 * used by `initProject({ installSeedAgents: true })` and `cleo agent mint`.
 *
 * Invocation mechanism (ADR-055 R1 resolution):
 *   1. Preferred: subprocess via `cleo orchestrate spawn <agentId> --no-worktree`
 *      This leverages the full CANT runtime, token injection, and spawn prompt.
 *   2. Fallback: when the CANT runtime is unavailable or dry-run is requested,
 *      skip invocation and return a `{ invoked: false, reason }` result. The
 *      caller is responsible for falling back to static seed-agent copy.
 *
 * User profile + project-context threading (AC6 / W3):
 *   `invokeMetaAgent()` reads `.cleo/project-context.json` and optionally calls
 *   `listUserProfile(nexusDb)` to build the token payload passed to the meta-agent.
 *   Both are serialized as JSON token args in the spawn invocation.
 *
 * @module agents/invoke-meta-agent
 * @task T1272 v2026.4.127 T1259 E2 agent-architect invocation shim
 * @task T1273 v2026.4.127 T1259 E2 user_profile + project-context threading
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveMetaAgentsDir } from './resolveStarterBundle.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Result of invoking a meta-agent.
 *
 * When `invoked: true` the agent completed successfully and `outputs` contains
 * the list of artifact filenames it reported (one per emitted line).
 *
 * When `invoked: false` the caller should fall back to static seed-agent copy.
 */
export interface MetaAgentResult {
  /** Whether the meta-agent was actually invoked. */
  invoked: boolean;
  /**
   * Reason for skipping invocation (only set when `invoked: false`).
   * Consumers may surface this as a warning log line.
   */
  reason?: string;
  /**
   * Artifact filenames reported by the meta-agent (lines matching
   * `agent-created: <name>.cant` or `playbook-created: <name>.cantbook`).
   * Only populated when `invoked: true`.
   */
  outputs?: string[];
  /** Raw stdout from the meta-agent process (for debugging). */
  stdout?: string;
}

/**
 * Token payload threaded into the meta-agent spawn invocation.
 *
 * Corresponds to the `tokens` block in `agent-architect.cant` and
 * `playbook-architect.cant`. Required tokens must be populated; optional
 * tokens may be omitted (meta-agent uses defaults).
 */
export interface MetaAgentTokens {
  /** Project name, kebab-case (e.g. "cleocode"). Required for agent-architect. */
  PROJECT_NAME?: string;
  /** Absolute path where the agent will write output .cant files. */
  CANT_AGENTS_DIR?: string;
  /** Semantic version of the agents bundle (e.g. "2026.4.127"). */
  BUNDLE_VERSION?: string;
  /** Serialized project-context.json (optional, improves synthesis quality). */
  PROJECT_CONTEXT?: string;
  /** Serialized user_profile rows as JSON array (optional). */
  USER_PROFILE?: string;
  /** Model override (e.g. "sonnet", "haiku"). Empty = use agent default. */
  MODEL_OVERRIDE?: string;
  /** Tier override. Empty = use agent default. */
  TIER_OVERRIDE?: string;
  /** Serialized skills list JSON array (e.g. ["ct-cleo", "ct-orchestrator"]). */
  SKILLS_JSON?: string;
  /** Serialized domains object JSON (e.g. {"tasks": "read"}). */
  DOMAINS_JSON?: string;
  /** Playbook name (used by playbook-architect only). */
  PLAYBOOK_NAME?: string;
  /** Workflow description (used by playbook-architect only). */
  WORKFLOW_DESCRIPTION?: string;
  /** Output directory for the .cantbook file (used by playbook-architect only). */
  OUTPUT_DIR?: string;
}

/**
 * Options for {@link invokeMetaAgent}.
 */
export interface InvokeMetaAgentOptions {
  /**
   * Meta-agent name without extension (e.g. "agent-architect").
   * Must match a file in `@cleocode/agents/meta/<name>.cant`.
   */
  agentName: string;
  /**
   * Absolute path to the project root (CWD for the subprocess).
   * Defaults to `process.cwd()`.
   */
  projectRoot?: string;
  /**
   * Token payload to thread into the spawn invocation.
   * Maps to the `tokens` block in the meta-agent's .cant file.
   */
  tokens?: MetaAgentTokens;
  /**
   * Optional open handle to `nexus.db` (Drizzle `NodeSQLiteDatabase`) for
   * reading user_profile rows. When provided, `invokeMetaAgent()` calls
   * `listUserProfile(nexusDb)` and threads the result as `USER_PROFILE` in
   * the token payload.
   *
   * Typed as `unknown` to avoid importing the heavy Drizzle type graph here.
   * The inner `listUserProfile` call uses a dynamic import and handles the cast.
   */
  // biome-ignore lint/suspicious/noExplicitAny: nexusDb is a Drizzle database handle; typed as any to avoid circular imports
  nexusDb?: any;
  /**
   * When `true`, skip subprocess invocation and return immediately with
   * `{ invoked: false, reason: 'dry-run' }`.
   * Default: false.
   */
  dryRun?: boolean;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Read `.cleo/project-context.json` from the given project root.
 * Returns the raw JSON string, or `null` when the file does not exist.
 */
function readProjectContext(projectRoot: string): string | null {
  const ctx = join(projectRoot, '.cleo', 'project-context.json');
  if (!existsSync(ctx)) return null;
  try {
    return readFileSync(ctx, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Attempt to read user profile rows from nexus.db.
 * Returns a serialized JSON array, or `null` when unavailable.
 *
 * Implements the W3 threading requirement: `listUserProfile(nexusDb)` is
 * called and the result is serialized as `USER_PROFILE` in the token payload.
 */
// biome-ignore lint/suspicious/noExplicitAny: nexusDb is a Drizzle database handle; typed as any to avoid circular imports
async function readUserProfile(nexusDb: any): Promise<string | null> {
  try {
    const { listUserProfile } = await import('../nexus/user-profile.js');
    const rows = await listUserProfile(nexusDb, { minConfidence: 0.5 });
    if (!rows || rows.length === 0) return null;
    return JSON.stringify(rows);
  } catch {
    // nexus.db not available or listUserProfile failed — degrade gracefully
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Invoke a CLEO meta-agent from the `@cleocode/agents/meta/` directory.
 *
 * Builds a rich token payload from project-context.json + user_profile, then
 * attempts to invoke the meta-agent via `cleo orchestrate spawn <agentName>
 * --no-worktree` in a subprocess. Falls back gracefully when the meta-agent
 * cannot be located or the subprocess fails.
 *
 * @param options - See {@link InvokeMetaAgentOptions}.
 * @returns A {@link MetaAgentResult} describing the outcome.
 *
 * @example
 * ```typescript
 * const result = await invokeMetaAgent({
 *   agentName: 'agent-architect',
 *   projectRoot: '/path/to/project',
 *   tokens: {
 *     PROJECT_NAME: 'my-app',
 *     CANT_AGENTS_DIR: '/path/to/project/.cleo/cant/agents',
 *     BUNDLE_VERSION: '2026.4.127',
 *   },
 *   nexusDb,
 * });
 *
 * if (!result.invoked) {
 *   // Fall back to static seed-agent copy
 *   console.warn('Meta-agent unavailable:', result.reason);
 * }
 * ```
 *
 * @task T1272 — invocation shim
 * @task T1273 — user_profile + project-context threading
 */
export async function invokeMetaAgent(options: InvokeMetaAgentOptions): Promise<MetaAgentResult> {
  const { agentName, projectRoot = process.cwd(), tokens = {}, nexusDb, dryRun = false } = options;

  if (dryRun) {
    return { invoked: false, reason: 'dry-run requested' };
  }

  // 1. Verify meta-agent .cant file exists
  const metaDir = resolveMetaAgentsDir();
  if (!metaDir) {
    return {
      invoked: false,
      reason: `@cleocode/agents/meta/ directory not found — cannot locate ${agentName}.cant`,
    };
  }
  const cantPath = join(metaDir, `${agentName}.cant`);
  if (!existsSync(cantPath)) {
    return {
      invoked: false,
      reason: `Meta-agent file not found: ${cantPath}`,
    };
  }

  // 2. Build enriched token payload (W3: project-context + user_profile threading)
  const enrichedTokens: MetaAgentTokens = { ...tokens };

  // Thread project-context.json when not already provided by caller
  if (!enrichedTokens.PROJECT_CONTEXT) {
    const ctxJson = readProjectContext(projectRoot);
    if (ctxJson) {
      enrichedTokens.PROJECT_CONTEXT = ctxJson;
    }
  }

  // Thread user_profile when nexusDb provided and not already set
  if (nexusDb && !enrichedTokens.USER_PROFILE) {
    const profileJson = await readUserProfile(nexusDb);
    if (profileJson) {
      enrichedTokens.USER_PROFILE = profileJson;
    }
  }

  // 3. Attempt subprocess invocation via `cleo orchestrate spawn`
  try {
    const { spawnSync } = await import('node:child_process');

    // Build --var args for each token
    const varArgs: string[] = [];
    for (const [key, value] of Object.entries(enrichedTokens)) {
      if (value !== undefined && value !== '') {
        varArgs.push('--var', `${key}=${value}`);
      }
    }

    const result = spawnSync(
      'cleo',
      ['orchestrate', 'spawn', agentName, '--no-worktree', ...varArgs],
      {
        cwd: projectRoot,
        encoding: 'utf-8',
        timeout: 120_000, // 2 minute timeout for meta-agent invocation
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    if (result.error) {
      return {
        invoked: false,
        reason: `subprocess error: ${result.error.message}`,
      };
    }

    if (result.status !== 0) {
      return {
        invoked: false,
        reason: `meta-agent exited with code ${result.status}: ${result.stderr?.trim() ?? '(no stderr)'}`,
      };
    }

    // Parse output lines for artifact reports
    const stdout = result.stdout ?? '';
    const outputPattern = /^(?:agent|playbook)-created:\s+(.+)$/m;
    const outputs: string[] = [];
    for (const line of stdout.split('\n')) {
      const match = outputPattern.exec(line.trim());
      if (match) {
        outputs.push(match[1].trim());
      }
    }

    return { invoked: true, outputs, stdout };
  } catch (err) {
    return {
      invoked: false,
      reason: `invocation failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Build the standard token payload for `agent-architect` invocation.
 *
 * Convenience wrapper around {@link invokeMetaAgent} for the primary use case:
 * `cleo init --install-seed-agents`.
 *
 * @param projectRoot - Absolute path to the project root.
 * @param cantAgentsDir - Absolute path where agent-architect writes output .cant files.
 * @param bundleVersion - Semantic version string (e.g. "2026.4.127").
 * @param nexusDb - Optional open nexus.db handle for user_profile threading.
 * @returns A {@link MetaAgentResult}.
 *
 * @task T1272
 * @task T1273
 */
export async function invokeAgentArchitect(
  projectRoot: string,
  cantAgentsDir: string,
  bundleVersion: string,
  // biome-ignore lint/suspicious/noExplicitAny: nexusDb is a Drizzle database handle; typed as any to avoid circular imports
  nexusDb?: any,
): Promise<MetaAgentResult> {
  const projectName =
    projectRoot
      .split('/')
      .pop()
      ?.toLowerCase()
      .replace(/[^a-z0-9-]/g, '-') ?? 'project';

  return invokeMetaAgent({
    agentName: 'agent-architect',
    projectRoot,
    nexusDb,
    tokens: {
      PROJECT_NAME: projectName,
      CANT_AGENTS_DIR: cantAgentsDir,
      BUNDLE_VERSION: bundleVersion,
    },
  });
}
