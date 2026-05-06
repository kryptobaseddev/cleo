/**
 * SDK helper — resolve the absolute path to the `@cleocode/agents`
 * meta/ directory and templates/ directory.
 *
 * The `meta/` directory ships CLEO meta-agents (e.g. `agent-architect.cant`,
 * `playbook-architect.cant`) that are invoked at project-init time to
 * synthesize project-specific agents from templates + context. These files
 * live in `@cleocode/agents/meta/` and are included in the package `files[]`
 * array (package.json), so they are present in both workspace and installed
 * layouts.
 *
 * The `templates/` directory ships direct-usable agent `.cant` files (the
 * canonical install set per ADR-068 / T1929). This replaces the deleted
 * `starter-bundle/` directory. The templates/ layout is flat — no `agents/`
 * subdirectory.
 *
 * Resolution order (first hit wins):
 *  1. `require.resolve('@cleocode/agents/package.json')` → sibling workspace
 *     or installed-package root → `<root>/templates`.
 *  2. Walk a set of relative candidates from this file's location to cover
 *     both workspace (`packages/core/src/agents/` → `packages/agents/`) and
 *     compiled (`packages/core/dist/agents/` → `packages/agents/`) layouts.
 *
 * Returns `null` when the directory cannot be located. Callers MUST
 * treat `null` as a soft-fail and degrade gracefully.
 *
 * @module agents/resolveAgentTemplates
 * @task T1935 v2026.5.x — rename resolveStarterBundle → resolveAgentTemplates (T1929 Phase 1)
 * @task T1271 v2026.4.127 T1259 E2 meta/ loader helper
 */

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Meta-agents directory helper
// ---------------------------------------------------------------------------

/**
 * Resolve the absolute path to the `@cleocode/agents/meta/` directory.
 *
 * Returns `null` when the package cannot be located or the `meta/` sub-directory
 * is absent. Callers SHOULD treat `null` as a soft-fail.
 *
 * @returns Absolute path to the meta agents root, or `null` when unresolved.
 *
 * @example
 * ```typescript
 * const metaDir = resolveMetaAgentsDir();
 * if (metaDir) {
 *   const architectPath = join(metaDir, 'agent-architect.cant');
 * }
 * ```
 *
 * @task T1271
 */
export function resolveMetaAgentsDir(): string | null {
  // Primary: workspace module resolution against the published package root.
  try {
    const req = createRequire(import.meta.url);
    const agentsPkgJson = req.resolve('@cleocode/agents/package.json');
    const candidate = join(dirname(agentsPkgJson), 'meta');
    if (existsSync(candidate)) return candidate;
  } catch {
    // Package unreachable — fall through to relative walk.
  }

  // Fallback: climb relative to this file's location. Works in both
  // workspace (src/) and compiled (dist/) layouts without requiring the
  // consumer to have `@cleocode/agents` declared as a direct dependency.
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // packages/core/src/agents/ → packages/agents/meta
    join(here, '..', '..', '..', 'agents', 'meta'),
    // packages/core/dist/agents/ → packages/agents/meta
    join(here, '..', '..', '..', '..', 'agents', 'meta'),
    // node_modules/@cleocode/core/dist/agents/ → ../agents/meta
    join(here, '..', '..', '..', '..', '..', 'agents', 'meta'),
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

// ---------------------------------------------------------------------------
// Agent templates directory helper (ADR-068 / T1929 canonical)
// ---------------------------------------------------------------------------

/** Tracks whether the deprecation warning for resolveStarterBundle has fired. */
let _starterBundleWarnFired = false;

/**
 * Resolve the absolute path to the `@cleocode/agents/templates/` directory on disk.
 *
 * The `templates/` directory ships the canonical direct-usable agent `.cant` files
 * for `cleo init` (the install set). Per ADR-068 (T1929) this replaces the
 * deleted `starter-bundle/` directory. The layout is flat — there is no `agents/`
 * subdirectory inside `templates/`.
 *
 * Paths are resolved via Node's ESM module-graph — callers MUST NOT
 * hardcode filesystem paths (per D026). Callers that only need the path for
 * display purposes should treat a `null` return as "not shipped" and emit a
 * warning rather than crashing.
 *
 * @returns Absolute path to the templates root, or `null` when unresolved.
 *
 * @example
 * ```typescript
 * const templatesDir = resolveAgentTemplates();
 * if (templatesDir) {
 *   const orchPath = join(templatesDir, 'project-orchestrator.cant');
 * }
 * ```
 *
 * @task T1935 T1929 ADR-068
 */
export function resolveAgentTemplates(): string | null {
  // Primary: workspace module resolution against the published package root.
  try {
    const req = createRequire(import.meta.url);
    const agentsPkgJson = req.resolve('@cleocode/agents/package.json');
    const candidate = join(dirname(agentsPkgJson), 'templates');
    if (existsSync(candidate)) return candidate;
  } catch {
    // Package unreachable — fall through to relative walk.
  }

  // Fallback: climb relative to this file's location. Works in both
  // workspace (src/) and compiled (dist/) layouts without requiring the
  // consumer to have `@cleocode/agents` declared as a direct dependency.
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // packages/core/src/agents/ → packages/agents/templates
    join(here, '..', '..', '..', 'agents', 'templates'),
    // packages/core/dist/agents/ → packages/agents/templates
    join(here, '..', '..', '..', '..', 'agents', 'templates'),
    // node_modules/@cleocode/core/dist/agents/ → ../agents/templates
    join(here, '..', '..', '..', '..', '..', 'agents', 'templates'),
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

// ---------------------------------------------------------------------------
// Deprecated aliases — back-compat for callers not yet migrated post-T1929
// ---------------------------------------------------------------------------

/**
 * @deprecated Use {@link resolveAgentTemplates} instead. This alias will be
 * removed in v2027.x. Kept for back-compat with code that has not yet
 * migrated post-T1929 (ADR-068). Emits a console.warn on first call.
 *
 * @returns Absolute path to the agent templates root (was: starter-bundle root), or `null`.
 * @task T1935 — deprecated alias preserved for one minor release
 */
export function resolveStarterBundle(): string | null {
  if (!_starterBundleWarnFired) {
    _starterBundleWarnFired = true;
    console.warn(
      '[cleo][deprecated] resolveStarterBundle() is deprecated and will be removed in v2027.x. ' +
        'Use resolveAgentTemplates() instead (ADR-068 / T1929).',
    );
  }
  return resolveAgentTemplates();
}

/**
 * Resolve the absolute path to the agent templates directory.
 *
 * In the ADR-068 layout the `templates/` directory is flat — there is no
 * `agents/` subdirectory. This alias returns the templates root directly.
 *
 * @deprecated Use {@link resolveAgentTemplates} instead. The flat templates/
 * layout does not have an `agents/` subdirectory. This alias will be removed
 * in v2027.x.
 *
 * @returns Absolute path to the templates root, or `null` when unresolved.
 * @task T1935
 */
export function resolveStarterBundleAgentsDir(): string | null {
  return resolveAgentTemplates();
}

/**
 * @deprecated The `team.cant` file was deleted as part of ADR-068 (T1932).
 * The templates/ layout is flat with individual agent `.cant` files.
 * This function always returns `null`. Will be removed in v2027.x.
 *
 * @returns Always `null` — team.cant no longer ships with @cleocode/agents.
 * @task T1935
 */
export function resolveStarterBundleTeamFile(): string | null {
  return null;
}

/**
 * @deprecated CLEOOS-IDENTITY.md no longer ships in @cleocode/agents
 * (starter-bundle deleted per ADR-068 / T1932). See `scaffold.ts` for the
 * updated resolution strategy. This function always returns `null`.
 * Will be removed in v2027.x.
 *
 * @returns Always `null` — CLEOOS-IDENTITY.md is not bundled in @cleocode/agents.
 * @task T1935
 */
export function resolveStarterBundleIdentityFile(): string | null {
  return null;
}

// ---------------------------------------------------------------------------
// Location descriptor (used by callers that need a typed result object)
// ---------------------------------------------------------------------------

/**
 * Structured result returned by the agent-templates resolution helpers.
 *
 * @task T1935
 */
export interface AgentTemplatesLocation {
  /** Absolute path to the `@cleocode/agents/templates/` directory. */
  templatesDir: string;
}
