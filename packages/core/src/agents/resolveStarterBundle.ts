/**
 * SDK helper — resolve the absolute path to the `@cleocode/agents`
 * meta/ directory.
 *
 * The `meta/` directory ships CLEO meta-agents (e.g. `agent-architect.cant`,
 * `playbook-architect.cant`) that are invoked at project-init time to
 * synthesize project-specific agents from templates + context. These files
 * live in `@cleocode/agents/meta/` and are included in the package `files[]`
 * array (package.json), so they are present in both workspace and installed
 * layouts.
 *
 * Resolution order (first hit wins):
 *  1. `require.resolve('@cleocode/agents/package.json')` → sibling workspace
 *     or installed-package root → `<root>/meta`.
 *  2. Walk a set of relative candidates from this file's location to cover
 *     both workspace (`packages/core/src/agents/` → `packages/agents/`) and
 *     compiled (`packages/core/dist/agents/` → `packages/agents/`) layouts.
 *
 * Returns `null` when the meta directory cannot be located. Callers MUST
 * treat `null` as a soft-fail and degrade gracefully (e.g. fall back to
 * static seed-agent copy).
 *
 * @module agents/resolveMetaAgentsDir
 * @task T1271 v2026.4.127 T1259 E2 meta/ loader helper
 */

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
// Starter-bundle helpers (legacy, kept for backward compat)
// ---------------------------------------------------------------------------

/**
 * SDK helper — resolve the absolute path to the `@cleocode/agents`
 * starter-bundle directory.
 *
 * The starter-bundle ships **direct-usable** team + persona `.cant` files for
 * `cleo init --install-seed-agents` (the install set). It is distinct from
 * `packages/agents/seed-agents/` which ships `{{var}}` mustache TEMPLATES for
 * the meta-agent customisation flow. Both directories live inside the
 * `@cleocode/agents` package because both are universal agent content.
 *
 * Per D035 (v2026.4.111) the starter-bundle was relocated from
 * `@cleocode/cleo-os/starter-bundle/` → `@cleocode/agents/starter-bundle/`.
 * CleoOS is a harness; universal agent content does not belong there.
 *
 * Resolution order (first hit wins):
 *  1. `require.resolve('@cleocode/agents/package.json')` → sibling workspace
 *     or installed-package root → `<root>/starter-bundle`.
 *  2. Walk a set of relative candidates from this file's location to cover
 *     both workspace (`packages/core/src/agents/` → `packages/agents/`) and
 *     compiled (`packages/core/dist/agents/` → `packages/agents/`) layouts.
 *
 * Paths are resolved via Node's ESM module-graph — callers MUST NOT
 * hardcode filesystem paths (per D026). Callers that only need the path for
 * display purposes should treat a `null` return as "not shipped" and emit a
 * warning rather than crashing.
 *
 * @module agents/resolveStarterBundle
 * @task T1241 v2026.4.111 systemic hotfix — starter-bundle relocation
 * @task T1232 CLEO Agents Architecture Remediation
 */

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Resolve the absolute path to the `@cleocode/agents/starter-bundle/`
 * directory on disk.
 *
 * Returns `null` when the package cannot be located (e.g. the directory
 * structure is broken, or the caller is running inside a bundled/compiled
 * artifact where the workspace layout is unavailable). Callers SHOULD treat
 * `null` as a soft-fail and degrade gracefully.
 *
 * @returns Absolute path to the starter-bundle root, or `null` when unresolved.
 *
 * @example
 * ```typescript
 * const bundleDir = resolveStarterBundle();
 * if (bundleDir) {
 *   const teamSrc = join(bundleDir, 'team.cant');
 *   // ...
 * }
 * ```
 *
 * @task T1241
 */
export function resolveStarterBundle(): string | null {
  // Primary: workspace module resolution against the published package root.
  try {
    const req = createRequire(import.meta.url);
    const agentsPkgJson = req.resolve('@cleocode/agents/package.json');
    const candidate = join(dirname(agentsPkgJson), 'starter-bundle');
    if (existsSync(candidate)) return candidate;
  } catch {
    // Package unreachable — fall through to relative walk.
  }

  // Fallback: climb relative to this file's location. Works in both
  // workspace (src/) and compiled (dist/) layouts without requiring the
  // consumer to have `@cleocode/agents` declared as a direct dependency.
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // packages/core/src/agents/ → packages/agents/starter-bundle
    join(here, '..', '..', '..', 'agents', 'starter-bundle'),
    // packages/core/dist/agents/ → packages/agents/starter-bundle
    join(here, '..', '..', '..', '..', 'agents', 'starter-bundle'),
    // node_modules/@cleocode/core/dist/agents/ → ../agents/starter-bundle
    join(here, '..', '..', '..', '..', '..', 'agents', 'starter-bundle'),
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

/**
 * Resolve the absolute path to the `starter-bundle/agents/` sub-directory
 * that carries the four persona `.cant` files.
 *
 * @returns Absolute path to the agents directory, or `null` when unresolved.
 * @task T1241
 */
export function resolveStarterBundleAgentsDir(): string | null {
  const root = resolveStarterBundle();
  return root === null ? null : join(root, 'agents');
}

/**
 * Resolve the absolute path to the canonical `team.cant` file shipped with
 * the starter bundle.
 *
 * @returns Absolute path to `team.cant`, or `null` when unresolved.
 * @task T1241
 */
export function resolveStarterBundleTeamFile(): string | null {
  const root = resolveStarterBundle();
  return root === null ? null : join(root, 'team.cant');
}

/**
 * Resolve the absolute path to the canonical `CLEOOS-IDENTITY.md` file
 * shipped with the starter bundle.
 *
 * Kept alongside the team + persona `.cant` files so the starter install
 * remains a single, atomic bundle. Callers that need the identity file
 * (e.g. `ensureGlobalIdentity` in `scaffold.ts`) should prefer this helper
 * over the legacy `packages/cleo-os/starter-bundle/...` path.
 *
 * @returns Absolute path to `CLEOOS-IDENTITY.md`, or `null` when unresolved.
 * @task T1241
 */
export function resolveStarterBundleIdentityFile(): string | null {
  const root = resolveStarterBundle();
  return root === null ? null : join(root, 'CLEOOS-IDENTITY.md');
}
