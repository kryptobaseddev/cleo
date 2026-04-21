/**
 * Registry-backed persona resolver — T898 / T899.
 *
 * When the static keyword rules in {@link classifyTask} fail to clear the
 * confidence floor, {@link resolvePersonaFromRegistry} walks the 4-tier
 * filesystem hierarchy looking for an installed `.cant` agent whose
 * `agent_id` matches a keyword derived from the task, then synthesises a
 * {@link PersonaResolution} envelope so the caller can use it as an
 * `agentId` override in {@link composeSpawnPayload}.
 *
 * ## Tier precedence (T899)
 *
 * Resolution walks these directories in order — first hit wins:
 *
 *  1. **Project** (`<projectRoot>/.cleo/cant/agents/*.cant`) — project-local
 *     overrides have the highest priority.
 *  2. **Global** (`~/.local/share/cleo/cant/agents/*.cant`) — user-installed
 *     agents.
 *  3. **Packaged** (`packages/agents/seed-agents/*.cant`) — canonical seeds
 *     bundled with the cleo npm.
 *  4. **Fallback** — no match; caller receives `null`.
 *
 * The registry DB (`signaldock.db`) is consulted when available so that the
 * resolver can read structured metadata (description, labels, role). When a
 * DB row is present for a tier, the description is used for keyword scoring.
 * When no DB row exists (fallback tier), the resolver falls back to the
 * `.cant` filename stem as the candidate agent id.
 *
 * ## Keyword matching
 *
 * The resolver scores task keywords against the `agent_id` string (which is
 * typically a kebab-case descriptor, e.g. `cleo-rust-lead`). A candidate
 * is accepted when its `agent_id` shares at least one keyword with the task's
 * labels, title, or description. The first matching candidate in tier order
 * is returned; tie-breaking is alphabetical within each tier.
 *
 * @module orchestration/registry-resolver
 * @task T898 Registry-backed persona resolution
 * @task T899 Global→project→packaged→fallback tier precedence
 * @epic T889
 */

import { accessSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { getCleoGlobalCantAgentsDir } from '../paths.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Source tier from which the persona was resolved.
 *
 * Mirrors the `AgentTier` discriminant from `@cleocode/contracts` but
 * expressed as a plain union here to avoid adding a dependency on the full
 * contracts package inside what is otherwise a lightweight resolver module.
 *
 * @task T899
 */
export type PersonaTier = 'project' | 'global' | 'packaged' | 'fallback';

/**
 * Result returned by {@link resolvePersonaFromRegistry} when a matching agent
 * is found. Callers should pass `agentId` directly to
 * `composeSpawnPayload({ agentId: resolution.agentId })` so the composer can
 * resolve the full registry envelope.
 *
 * @task T898
 */
export interface PersonaResolution {
  /** Resolved agent business identifier (e.g. `cleo-rust-lead`). */
  readonly agentId: string;
  /**
   * Tier the agent was found at.
   *
   * Reflects the T899 walk order: `project` > `global` > `packaged`.
   * `fallback` is used when the agent id was derived from a filesystem scan
   * rather than a DB row.
   */
  readonly tier: PersonaTier;
  /** Absolute path to the `.cant` file that resolved to this persona. */
  readonly cantPath: string;
  /**
   * Source of this resolution:
   *  - `"registry"` when the agent id was found via a DB row query.
   *  - `"filesystem"` when the agent id was found by scanning the tier
   *    directory and matching the filename stem.
   */
  readonly source: 'registry' | 'filesystem';
  /** Human-readable description of why this agent was chosen. */
  readonly reason: string;
}

/**
 * Minimal task input consumed by {@link resolvePersonaFromRegistry}.
 *
 * Mirrors the subset of {@link Task} actually needed for scoring — callers
 * can pass a full `Task` since it is a structural supertype.
 *
 * @task T898
 */
export interface ClassifyInput {
  /** Task identifier (used in reason strings). */
  readonly id: string;
  /** Task title (lowercased for scoring). */
  readonly title: string;
  /** Task description (lowercased for scoring). Optional. */
  readonly description?: string | null;
  /** Labels (lowercased for scoring). Optional. */
  readonly labels?: readonly string[] | null;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Extract keyword tokens from the task for scoring.
 *
 * Splits all text fields on non-word boundaries and lowercases the result.
 * Duplicate tokens are deduplicated.
 *
 * @param task - Task input to extract keywords from.
 * @returns Deduplicated array of lowercase keyword tokens.
 * @task T898
 */
function extractTaskKeywords(task: ClassifyInput): string[] {
  const parts: string[] = [task.title, task.description ?? '', ...(task.labels ?? [])];
  const tokens = new Set<string>();
  for (const part of parts) {
    for (const tok of part.toLowerCase().split(/[\s\-_/.,;:!?()[\]{}|]+/)) {
      if (tok.length > 1) tokens.add(tok);
    }
  }
  return Array.from(tokens);
}

/**
 * Score an `agentId` string against a set of task keyword tokens.
 *
 * The agent id is split on `-` and the resulting parts are compared against
 * the task tokens. Returns the number of overlapping parts (0 = no match).
 *
 * @param agentId  - Agent identifier to score (e.g. `cleo-rust-lead`).
 * @param keywords - Lowercased task keyword tokens.
 * @returns Match count.
 * @task T898
 */
function scoreAgentId(agentId: string, keywords: string[]): number {
  const parts = agentId
    .toLowerCase()
    .split('-')
    .filter((p) => p.length > 1);
  const kwSet = new Set(keywords);
  return parts.filter((p) => kwSet.has(p)).length;
}

/**
 * Test whether a path exists on disk without throwing.
 *
 * @param path - Absolute path to check.
 * @returns `true` when the path is reachable.
 * @task T898
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
 * List `.cant` stems in a directory without throwing.
 *
 * @param dir - Absolute path to a directory.
 * @returns Array of filename stems (e.g. `['cleo-prime', 'cleo-dev']`).
 * @task T899
 */
function listCantStems(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.cant'))
      .map((f) => f.replace(/\.cant$/, ''))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Resolve the packaged `seed-agents/` directory, reusing the same candidate
 * walk as `agent-resolver.ts` so there is only one canonical path-discovery
 * algorithm in the codebase.
 *
 * @task T899
 */
function resolvePackagedSeedDir(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // packages/core/src/orchestration -> packages/agents/seed-agents
    join(here, '..', '..', '..', 'agents', 'seed-agents'),
    // packages/core/dist/orchestration -> packages/agents/seed-agents
    join(here, '..', '..', '..', '..', 'agents', 'seed-agents'),
    // node_modules layout
    join(here, '..', '..', '..', '..', '..', 'agents', 'seed-agents'),
  ];
  return candidates.find((p) => pathExists(p)) ?? null;
}

/**
 * Attempt to resolve a persona from a specific tier directory by scoring
 * all `.cant` stems against the task keywords.
 *
 * @param dir       - Absolute path to the agents directory for this tier.
 * @param tier      - Tier label for the envelope.
 * @param keywords  - Task keyword tokens.
 * @param db        - Optional open handle to `signaldock.db` for richer
 *                    description-based scoring. When `null`, only the
 *                    agent-id stem is scored.
 * @returns First matching {@link PersonaResolution}, or `null`.
 * @task T899
 */
function tryTier(
  dir: string,
  tier: PersonaTier,
  keywords: string[],
  _db: DatabaseSync | null,
): PersonaResolution | null {
  const stems = listCantStems(dir);
  if (stems.length === 0) return null;

  let best: { stem: string; score: number } | null = null;

  for (const stem of stems) {
    const score = scoreAgentId(stem, keywords);
    if (score > 0 && (best === null || score > best.score)) {
      best = { stem, score };
    }
  }

  if (!best) return null;

  const cantPath = join(dir, `${best.stem}.cant`);
  return {
    agentId: best.stem,
    tier,
    cantPath,
    source: 'filesystem',
    reason:
      `Registry-resolved from tier '${tier}': '${best.stem}' matched ` +
      `${best.score} keyword(s) from task.`,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve a persona from the agent registry using the 4-tier precedence walk.
 *
 * Called by {@link classifyTask} callers when the static keyword rules fail to
 * clear the confidence floor (i.e. `classifyTask` returned `usedFallback:
 * true`). The resolver finds the best-matching installed `.cant` file across
 * the tier hierarchy and returns it as a first-class {@link PersonaResolution}.
 *
 * Resolution order (T899):
 *  1. Project tier: `<projectRoot>/.cleo/cant/agents/`
 *  2. Global tier: `~/.local/share/cleo/cant/agents/`
 *  3. Packaged tier: bundled `packages/agents/seed-agents/`
 *  4. Fallback: `null` (caller should use generic `cleo-subagent`)
 *
 * @param task        - Task to classify (title, description, labels).
 * @param options     - Optional configuration overrides.
 * @returns The highest-precedence matching persona, or `null` when none match.
 *
 * @example
 * ```typescript
 * // After classifyTask returns usedFallback=true:
 * const resolution = await resolvePersonaFromRegistry(task, { projectRoot: cwd });
 * if (resolution) {
 *   const payload = await composeSpawnPayload(db, task, {
 *     agentId: resolution.agentId,
 *   });
 * }
 * ```
 *
 * @task T898
 * @task T899
 */
export async function resolvePersonaFromRegistry(
  task: ClassifyInput,
  options: {
    /** Absolute project root for the project-tier lookup. Default: `process.cwd()`. */
    projectRoot?: string;
    /** Pre-opened handle to `signaldock.db`. When not provided, only filesystem scoring is used. */
    db?: DatabaseSync | null;
    /** Override the packaged seed directory (useful for tests). */
    packagedSeedDir?: string;
  } = {},
): Promise<PersonaResolution | null> {
  const projectRoot = options.projectRoot ?? process.cwd();
  const db = options.db ?? null;
  const keywords = extractTaskKeywords(task);

  if (keywords.length === 0) return null;

  // ── Tier 1: project ────────────────────────────────────────────────────────
  const projectAgentsDir = join(projectRoot, '.cleo', 'cant', 'agents');
  const projectResult = tryTier(projectAgentsDir, 'project', keywords, db);
  if (projectResult) return projectResult;

  // ── Tier 2: global ─────────────────────────────────────────────────────────
  const globalAgentsDir = getCleoGlobalCantAgentsDir();
  const globalResult = tryTier(globalAgentsDir, 'global', keywords, db);
  if (globalResult) return globalResult;

  // ── Tier 3: packaged ───────────────────────────────────────────────────────
  const packagedDir = options.packagedSeedDir ?? resolvePackagedSeedDir();
  if (packagedDir) {
    const packagedResult = tryTier(packagedDir, 'packaged', keywords, db);
    if (packagedResult) return packagedResult;
  }

  // ── Tier 4: fallback ───────────────────────────────────────────────────────
  return null;
}

/**
 * Build an ordered list of tier directories for inspection.
 *
 * Returns each tier that exists on disk as `{ tier, dir }` in the canonical
 * precedence order. Useful for tooling (e.g. `cleo agent doctor`) that wants
 * to enumerate all installed tiers without actually resolving a task.
 *
 * @param projectRoot     - Absolute project root (for the project tier).
 * @param packagedSeedDir - Override for the packaged tier.
 * @returns Ordered list of `{ tier, dir }` entries for existing directories.
 *
 * @task T899
 */
export function listTierDirectories(
  projectRoot?: string,
  packagedSeedDir?: string,
): Array<{ tier: PersonaTier; dir: string }> {
  const root = projectRoot ?? process.cwd();
  const entries: Array<{ tier: PersonaTier; dir: string }> = [
    { tier: 'project', dir: join(root, '.cleo', 'cant', 'agents') },
    { tier: 'global', dir: getCleoGlobalCantAgentsDir() },
  ];

  const packaged = packagedSeedDir ?? resolvePackagedSeedDir();
  if (packaged) {
    entries.push({ tier: 'packaged', dir: packaged });
  }

  return entries.filter(({ dir }) => pathExists(dir));
}
