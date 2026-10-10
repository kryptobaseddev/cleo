/**
 * Core init logic - project initialization and maintenance.
 *
 * Single source of truth for all init operations. CLI delegates here
 * (shared-core pattern).
 *
 * Handles:
 *   1. .cleo/ directory structure creation
 *   2. Core data files (config.json, tasks.db)
 *   3. Schema file installation (~/.cleo/schemas/)
 *   4. Sequence counter (SQLite schema_meta)
 *   5. Project info (.cleo/project-info.json)
 *   6. CAAMP injection into agent instruction files (AGENTS.md hub pattern)
 *   7. Agent definition installation (cleo-subagent)
 *   9. Core skill installation via CAAMP
 *  10. NEXUS project registration
 *  11. Project type detection (--detect)
 *  12. Injection refresh
 *  13. Git hook installation (commit-msg, pre-commit)
 *  14. GitHub issue/PR templates (.github/ directory)
 *
 * @task T4681
 * @task T4682
 * @task T4684
 * @task T4685
 * @task T4686
 * @task T4687
 * @task T4689
 * @task T4706
 * @task T4707
 * @epic T4663
 */

import {
  copyFileSync,
  existsSync,
  constants as fsConstants,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import {
  appendFile,
  copyFile,
  lstat,
  mkdir,
  readFile,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { platform } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import type { Provider } from '@cleocode/caamp';
import { ExitCode } from '@cleocode/contracts/exit-codes.js';
import { isAbsolutePath } from '@cleocode/paths';
import { classifyProject, type ProjectClassification } from './discovery.js';
import { CleoError } from './errors.js';
import { resolveGitDir, resolveHooksDir } from './git/hooks-install.js';
import { ensureGitHooks, MANAGED_HOOKS } from './hooks.js';
import { ensureInjection } from './injection.js';
import { writeMemoryBridge } from './memory/memory-bridge.js';
import { migrateAgentOutputs } from './migration/agent-outputs.js';
import { pushWarning } from './output.js';
import {
  getAgentsHome,
  getCleoDir,
  getCleoDirAbsolute,
  getCleoHome,
  getProjectRoot,
  isGitLinkedCheckout,
  linkedWorktreeMainRoot,
  recordProjectEncounter,
  resolveCleoDir,
  worktreeScope,
} from './paths.js';
import { captureProjectScope } from './project-scope.js';
// Shared utility imports
import {
  ensureBrainDb,
  ensureCleoGitRepo,
  ensureCleoOsHub,
  ensureCleoStructure,
  ensureConfig,
  ensureGitignore,
  ensureProjectContext,
  ensureProjectGitInitialCommit,
  ensureProjectInfo,
  ensureWorktreeInclude,
  getPackageRoot,
  removeCleoFromRootGitignore,
} from './scaffold.js';
import { ensureGlobalSchemas } from './schema-management.js';
import { readJson } from './store/json.js';

// ── Types ────────────────────────────────────────────────────────────

/** Options for the init operation. */
export interface InitOptions {
  /** Project name override. */
  name?: string;
  /** Overwrite existing files. */
  force?: boolean;
  /** Auto-detect project configuration. */
  detect?: boolean;
  /** Run codebase analysis and store findings to brain.db. */
  mapCodebase?: boolean;
  /**
   * @deprecated No-op since T1934 / ADR-068. All five worker templates are
   * now automatically registered at project tier on every plain `cleo init`
   * call via {@link installTemplatesAtProjectTier}. Passing this flag emits
   * a deprecation warning and is otherwise ignored. The flag is preserved for
   * one minor release to avoid breaking existing scripts.
   */
  installSeedAgents?: boolean;
  /**
   * Mint a new project identity instead of re-linking one the global
   * registry already holds for this checkout (T12325). Has no effect when
   * `project-info.json` or the tracked `.cleo/project-id` already declares
   * an identity — neither is ever rewritten.
   */
  newIdentity?: boolean;
  /**
   * Point the registry row at this checkout even though its previous location
   * still exists on this device (T12470). Without it such a checkout is only a
   * `candidate`.
   */
  forceRebind?: boolean;
  /**
   * Initialize the current working directory itself, even when it sits inside
   * an ancestor CLEO project (T12562). A directory that is its own git root is
   * targeted without this flag.
   *
   * T12558: at a root a project was rerooted AWAY from, `here` alone is
   * refused (it would adopt the relocated project's id and create a second
   * store for it); `here` + {@link InitOptions.newIdentity} starts a genuinely
   * different project there, audited in `.cleo/audit/relocation-override.jsonl`.
   */
  here?: boolean;
}

/**
 * How {@link resolveInitTarget} chose the directory `cleo init` acts on.
 *
 * - `here` — `--here` asked for the current directory.
 * - `pinned` — a worktree scope, absolute `CLEO_DIR` or `CLEO_ROOT` pinned it.
 * - `git-root` — the current directory is its own git repository root (`.git`
 *   is a directory). A submodule / separate-git-dir gitlink is NOT: the
 *   resolver cannot use a store there yet (T12562).
 * - `resolved` — the ancestor walk; the current directory or an ancestor project.
 *
 * @task T12562
 */
export type InitTargetSource = 'here' | 'pinned' | 'git-root' | 'resolved';

/**
 * The nearest git checkout boundary at or above the working directory.
 *
 * - `repo` — `.git` is a directory.
 * - `submodule` — `.git` is a gitlink to a separate repository (a submodule
 *   or `--separate-git-dir`). It is its own repository, but project-root
 *   resolution still walks past it, so init must not give it a store (T12562).
 * - `worktree` — `.git` is a gitlink into `<common>/worktrees/<name>`: a
 *   linked worktree that shares its main checkout's CLEO project (D009).
 *
 * @task T12562
 */
export interface InitGitBoundary {
  /** Absolute directory that holds the `.git` entry. */
  root: string;
  /** Kind of checkout. */
  kind: 'repo' | 'submodule' | 'worktree';
  /** For `worktree`: the main checkout the worktree belongs to. */
  mainRoot?: string;
}

/**
 * The directory `cleo init` will act on, and whether it is the current directory.
 *
 * @task T12562
 */
export interface InitTarget {
  /** Absolute path of the target's `.cleo/` directory. */
  cleoDir: string;
  /** Absolute path of the target project root (parent of `cleoDir`). */
  projectRoot: string;
  /** Absolute path of the working directory init was invoked from. */
  cwd: string;
  /** Rule that selected the target. */
  source: InitTargetSource;
  /** `true` when `projectRoot` is the working directory (compared by realpath). */
  isCwd: boolean;
  /** `true` when an absolute `CLEO_DIR` or `CLEO_ROOT` explicitly pinned the target. */
  envPinned: boolean;
  /** Nearest git checkout boundary at or above `cwd`, or `null` outside git. */
  gitBoundary: InitGitBoundary | null;
  /**
   * For a `submodule` boundary: the initialized CLEO project that commands run
   * from it resolve to (the superproject), when there is one.
   */
  enclosingProjectRoot?: string;
}

/**
 * Stable machine-readable codes for `cleo init` refusals (T12562). Carried in
 * `CleoError.details.codeName` so the CLI and the dispatch engine can surface
 * them instead of a generic `E_INTERNAL` / "use force=true".
 *
 * @task T12562
 */
export const INIT_ERROR_CODES = {
  /** cwd is the initialized project root; `--force` re-initializes it. */
  alreadyInitialized: 'E_ALREADY_INITIALIZED',
  /** cwd is inside an ancestor project; init changed nothing. */
  ancestorProject: 'E_INIT_ANCESTOR_PROJECT',
  /** `--force` resolved to a root other than cwd. */
  forceNotCwd: 'E_INIT_FORCE_NOT_CWD',
  /** cwd is inside a linked git worktree; its project is the main checkout. */
  inWorktree: 'E_INIT_IN_WORKTREE',
  /** cwd is a submodule / separate-git-dir checkout under a CLEO project. */
  gitlinkUnsupported: 'E_INIT_GITLINK_UNSUPPORTED',
  /** The pre-`--force` snapshot could not be taken; nothing was changed. */
  snapshotFailed: 'E_INIT_SNAPSHOT_FAILED',
} as const;

/** Result of the init operation. */
export interface InitResult {
  initialized: boolean;
  directory: string;
  created: string[];
  skipped: string[];
  warnings: string[];
  updateDocsOnly?: boolean;
  /**
   * Phase 5 — Greenfield/brownfield classification of the directory.
   * Populated by the discovery module during init.
   */
  classification?: {
    kind: 'greenfield' | 'brownfield';
    signalCount: number;
    topLevelFileCount: number;
    hasGit: boolean;
  };
  /**
   * Phase 5 — Next-step guidance for the agent/operator, emitted as a
   * LAFS-compatible suggestion list. Each entry has an action description
   * and a copy-pasteable command.
   */
  nextSteps?: Array<{ action: string; command: string }>;
  /**
   * T1263 PSYCHE E6 — Recent session journal context for meta-agent consumption.
   *
   * Contains up to 5 most recent journal entries so the meta-agent (agent-architect)
   * can pick up prior session context at `cleo init` time without loading brain.db.
   * Absent when no journals exist or when `readRecentJournals` fails (best-effort).
   */
  sessionContext?: {
    /** Most recent session journal entries, newest first. */
    recentJournals: import('@cleocode/contracts').SessionJournalEntry[];
  };
}

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Symlink type for directory symlinks.
 * On Windows, use 'junction' (no admin privileges required).
 * On Unix, use 'dir'.
 */
const DIR_SYMLINK_TYPE: 'junction' | 'dir' = platform() === 'win32' ? 'junction' : 'dir';

// ── Init-specific operations ─────────────────────────────────────────

/**
 * Resolve the absolute path to the bundled `seed-agents/` directory inside
 * the `@cleocode/agents` package.
 *
 * Mirrors the multi-candidate resolution pattern used by
 * {@link initAgentDefinition} so the same code path works across all layouts:
 *   1. **npm install** — `require.resolve('@cleocode/agents/package.json')`
 *      finds the package under `node_modules/@cleocode/agents/`.
 *   2. **Workspace dev (bundled CLI)** — walks up from `getPackageRoot()`
 *      (which resolves to `packages/cleo/dist/` or `packages/core/`) to find
 *      `packages/agents/seed-agents/`.
 *   3. **Monorepo dev (source)** — falls back to `packages/agents/seed-agents/`
 *      relative to `getPackageRoot()`.
 *
 * @returns Absolute path to an existing `seed-agents/` directory, or `null`
 *          if no candidate exists. Returning `null` lets callers skip the
 *          seed install gracefully without crashing.
 *
 * @task T283
 * @epic T280
 */
export async function resolveSeedAgentsDir(): Promise<string | null> {
  // Primary: resolve via Node module resolution (@cleocode/agents)
  try {
    const { createRequire } = await import('node:module');
    const req = createRequire(import.meta.url);
    const agentsPkgMain = req.resolve('@cleocode/agents/package.json');
    const agentsPkgRoot = dirname(agentsPkgMain);
    const candidate = join(agentsPkgRoot, 'seed-agents');
    if (existsSync(candidate)) {
      return candidate;
    }
  } catch {
    // Not resolvable via require.resolve — fall through to bundled path
  }

  // Walk a series of candidate paths relative to getPackageRoot(), which
  // can resolve to several different locations depending on whether we're
  // running from packages/core/dist, packages/cleo/dist, or installed under
  // node_modules/@cleocode/.
  const packageRoot = getPackageRoot();
  const candidates = [
    // Workspace fallback: bundled alongside core under packages/agents/seed-agents
    join(packageRoot, 'agents', 'seed-agents'),
    // Sibling-package layout (e.g. node_modules/@cleocode/core -> ../agents)
    join(packageRoot, '..', 'agents', 'seed-agents'),
    // Bundled CLI: packages/cleo/dist -> ../../agents/seed-agents
    join(packageRoot, '..', '..', 'agents', 'seed-agents'),
    // Bundled CLI dist subdir: packages/cleo/dist/cli -> ../../../packages/agents
    join(packageRoot, '..', '..', 'packages', 'agents', 'seed-agents'),
    // Monorepo workspace from repo root
    join(packageRoot, '..', '..', '..', 'packages', 'agents', 'seed-agents'),
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

// ── Per-agent outcome of installTemplatesAtProjectTier ───────────────

/**
 * Per-agent outcome of {@link installTemplatesAtProjectTier}.
 *
 * @task T1934
 */
export interface TemplateInstallEntry {
  /** Business identifier of the agent (kebab-case, filename sans `.cant`). */
  readonly agentId: string;
  /** Absolute source path of the `.cant` template file. */
  readonly cantPath: string;
  /** Whether the DB row was inserted (`true`) or updated (`false`). */
  readonly inserted: boolean;
}

/**
 * Result of {@link installTemplatesAtProjectTier}.
 *
 * @task T1934
 */
export interface TemplateInstallResult {
  /** Agents that were successfully (re)registered. */
  readonly installed: ReadonlyArray<TemplateInstallEntry>;
  /** Agents that failed to install — paired with the error message. */
  readonly failed: ReadonlyArray<{ readonly cantPath: string; readonly error: string }>;
  /**
   * Absolute path to the templates directory that was scanned.
   * `null` when the templates directory could not be resolved.
   */
  readonly templatesDir: string | null;
}

/**
 * Walk `@cleocode/agents/templates/` and register every `project-*.cant` file
 * into the global `signaldock.db` registry with `tier = 'project'`.
 *
 * This is the load-bearing UX change introduced by T1934 (ADR-068): plain
 * `cleo init` (no flags) now produces a fully working agent dispatch system.
 * Each template is installed via the atomic {@link installAgentFromCant}
 * pipeline — the `.cant` file is copied to `.cleo/cant/agents/` AND the
 * `agents` row is written to `signaldock.db` in a single transaction.
 *
 * Idempotent: re-running init on an already-initialised project does not
 * duplicate rows — `force: true` rewrites stale rows instead of throwing.
 *
 * Tolerant of per-file failures: a malformed template blocks only its own
 * row and is reported in `failed`, leaving sibling installs intact.
 *
 * @param projectRoot - Absolute path to the project root.
 * @returns Per-file install outcomes and the directory that was scanned.
 *
 * @task T1934
 */
export async function installTemplatesAtProjectTier(
  projectRoot: string,
): Promise<TemplateInstallResult> {
  const { resolveAgentTemplates } = await import('./agents/resolveAgentTemplates.js');
  const templatesDir = resolveAgentTemplates();

  if (!templatesDir) {
    return { installed: [], failed: [], templatesDir: null };
  }

  const cantFiles = readdirSync(templatesDir).filter((f) => f.endsWith('.cant'));

  if (cantFiles.length === 0) {
    return { installed: [], failed: [], templatesDir };
  }

  // E6-L6 (T11526): the `agents` family is the legacy signaldock schema, created
  // inside the global `cleo.db` by ensureGlobalAgentRegistryDb() (which routes
  // through openDualScopeDb('global') AND runs the legacy signaldock migrations).
  // openCleoDb('global') alone would only create the consolidated schema.
  const { ensureGlobalAgentRegistryDb, getGlobalAgentRegistryNativeDb } = await import(
    './store/agent-registry-store.js'
  );
  await ensureGlobalAgentRegistryDb();
  const db = getGlobalAgentRegistryNativeDb();
  if (!db) {
    throw new Error('init: global signaldock cleo.db could not be opened (no native handle)');
  }

  const installed: TemplateInstallEntry[] = [];
  const failed: Array<{ cantPath: string; error: string }> = [];

  // NOTE: `db` is the SHARED dual-scope GLOBAL `cleo.db` handle owned by
  // openDualScopeDb('global') and co-owned by the nexus / skills domains
  // (E6-L5 · T11525). We MUST NOT `.close()` it here — doing so tears the
  // handle out from under sibling domains AND breaks the subsequent
  // forceInstallProjectTierAgents() call in `cleo init`, which re-uses the
  // same singleton and would otherwise hit "database is not open".
  const { installAgentFromCant } = await import('./store/agent-install.js');
  for (const filename of cantFiles) {
    const cantPath = join(templatesDir, filename);
    try {
      const result = installAgentFromCant(db, {
        cantSource: cantPath,
        targetTier: 'project',
        installedFrom: 'seed',
        projectRoot,
        force: true,
      });
      installed.push({
        agentId: result.agentId,
        cantPath: result.cantPath,
        inserted: result.inserted,
      });
    } catch (err) {
      failed.push({
        cantPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { installed, failed, templatesDir };
}

/**
 * Install cleo-subagent agent definition to ~/.agents/agents/.
 * @task T4685
 */
export async function initAgentDefinition(created: string[], warnings: string[]): Promise<void> {
  // Resolve agents package via require.resolve, then workspace/bundled fallback
  let agentSourceDir: string | null = null;
  try {
    const { createRequire } = await import('node:module');
    const req = createRequire(import.meta.url);
    const agentsPkgMain = req.resolve('@cleocode/agents/package.json');
    const agentsPkgRoot = dirname(agentsPkgMain);
    const candidate = join(agentsPkgRoot, 'cleo-subagent');
    if (existsSync(candidate)) {
      agentSourceDir = candidate;
    }
  } catch {
    // Not resolvable via require.resolve — fall through to bundled path
  }

  if (!agentSourceDir) {
    const packageRoot = getPackageRoot();
    const bundled = join(packageRoot, 'agents', 'cleo-subagent');
    if (existsSync(bundled)) {
      agentSourceDir = bundled;
    }
  }

  if (!agentSourceDir) {
    warnings.push('agents/cleo-subagent/ not found in package, skipping agent definition install');
    return;
  }

  const globalAgentsDir = join(getAgentsHome(), 'agents', 'cleo-subagent');
  await mkdir(dirname(globalAgentsDir), { recursive: true });

  try {
    // Check if symlink already exists and points to correct target
    try {
      const stat = await lstat(globalAgentsDir);
      if (stat.isSymbolicLink()) {
        const { readlink } = await import('node:fs/promises');
        const currentTarget = await readlink(globalAgentsDir);
        if (currentTarget === agentSourceDir) {
          return; // Symlink intact and pointing to correct location
        }
        // Stale symlink — remove and recreate
        await unlink(globalAgentsDir);
      } else if (stat.isDirectory()) {
        return; // Copied dir, leave as-is
      }
    } catch {
      // Doesn't exist, proceed to create
    }

    // Create symlink from ~/.agents/agents/cleo-subagent -> package agents/cleo-subagent/
    await symlink(agentSourceDir, globalAgentsDir, DIR_SYMLINK_TYPE);
    created.push('agent: cleo-subagent (symlinked)');
  } catch (_err) {
    // If symlink fails (e.g., permissions), try copying
    try {
      await mkdir(globalAgentsDir, { recursive: true });
      const files = readdirSync(agentSourceDir);
      for (const file of files) {
        await copyFile(join(agentSourceDir, file), join(globalAgentsDir, file));
      }
      created.push('agent: cleo-subagent (copied)');
    } catch (copyErr) {
      warnings.push(
        `Agent definition install: ${copyErr instanceof Error ? copyErr.message : String(copyErr)}`,
      );
    }
  }
}

/**
 * No-op. Kept for API compatibility.
 * @task T4706
 */
export async function initMcpServer(
  _projectRoot: string,
  _created: string[],
  _warnings: string[],
): Promise<void> {
  // No-op: removed
}

/**
 * Install CLEO core skills to the canonical skills directory via CAAMP.
 * @task T4707
 * @task T4689
 */
export async function initCoreSkills(created: string[], warnings: string[]): Promise<void> {
  try {
    const { getInstalledProviders, installResolvedSkill, registerSkillLibraryFromPath } =
      await import('@cleocode/caamp');

    const providers = getInstalledProviders();
    if (providers.length === 0) {
      return;
    }

    // Find skills package via require.resolve, then workspace path, then node_modules fallback
    const packageRoot = getPackageRoot();
    let ctSkillsRoot: string | null = null;
    try {
      // Primary: resolve via Node module resolution (@cleocode/skills)
      const { createRequire } = await import('node:module');
      const req = createRequire(import.meta.url);
      const skillsPkgMain = req.resolve('@cleocode/skills/package.json');
      const skillsPkgRoot = dirname(skillsPkgMain);
      if (existsSync(join(skillsPkgRoot, 'skills', 'manifest.json'))) {
        ctSkillsRoot = skillsPkgRoot;
      }
    } catch {
      // Not resolvable via require.resolve — try workspace and node_modules fallbacks
    }

    if (!ctSkillsRoot) {
      try {
        // Workspace monorepo fallback (packages/skills/)
        const bundledPath = join(packageRoot, 'packages', 'skills');
        if (existsSync(join(bundledPath, 'skills', 'manifest.json'))) {
          ctSkillsRoot = bundledPath;
        } else {
          // node_modules fallback
          const ctSkillsPath = join(packageRoot, 'node_modules', '@cleocode', 'skills');
          if (existsSync(join(ctSkillsPath, 'skills', 'manifest.json'))) {
            ctSkillsRoot = ctSkillsPath;
          }
        }
      } catch {
        // not found
      }
    }

    if (!ctSkillsRoot) {
      warnings.push('skills package not found, skipping core skill installation');
      return;
    }

    // Register bundled skill library with CAAMP
    try {
      registerSkillLibraryFromPath(ctSkillsRoot);
    } catch {
      warnings.push('Failed to register skill library with CAAMP');
    }

    // T12653: the manifest (generated from SKILL.md frontmatter) is the only
    // skills index. Install every skill that declares `metadata.install:
    // harness`; `internal` skills never reach a harness (D11157).
    // scripts/lint-emitted-skills.mjs mirrors this selection — change both.
    const manifestPath = join(ctSkillsRoot, 'skills', 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    const skills: Array<{ name: string; install?: string }> = manifest.skills ?? [];
    const harnessSkills = skills.filter((s) => s.install === 'harness');

    const installed: string[] = [];
    for (const skill of harnessSkills) {
      const skillSourceDir = join(ctSkillsRoot, 'skills', skill.name);

      if (!existsSync(skillSourceDir)) {
        continue;
      }

      try {
        // T12384: bundled skills pass the same gate as every other install.
        const result = await installResolvedSkill(
          {
            localPath: skillSourceDir,
            skillName: skill.name,
            sourceValue: `library:${skill.name}`,
            sourceType: 'library',
          },
          { providers, isGlobal: true },
        );
        if (result.success) {
          installed.push(skill.name);
        }
      } catch {
        // Skill may already be installed, continue
      }
    }

    if (installed.length > 0) {
      created.push(`skills: ${installed.length} core skills installed`);
    }

    // T12678: record what CLEO installed, then remove bundled skills CLEO no
    // longer installs (internal or retired) — only where CLEO owns them.
    await pruneAfterInstall(ctSkillsRoot, installed, providers, created, warnings);
  } catch (err) {
    warnings.push(`Core skill install: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Write the bundled-install ledger and prune skills the bundled manifest no
 * longer installs (T12678). Best-effort: failures become warnings.
 *
 * @param ctSkillsRoot - `@cleocode/skills` package root.
 * @param installed - Skills installed by this run.
 * @param providers - Installed harness providers.
 * @param created - Accumulator for created/removed messages.
 * @param warnings - Accumulator for warnings.
 */
async function pruneAfterInstall(
  ctSkillsRoot: string,
  installed: string[],
  providers: Provider[],
  created: string[],
  warnings: string[],
): Promise<void> {
  try {
    const { resolveProviderSkillsDirs } = await import('@cleocode/caamp');
    const { resolveSkillsRoot } = await import('./skills/skill-root.js');
    const { defaultPruneRegistry, pruneBundledSkills, recordBundledInstalls } = await import(
      './skills/prune-bundled.js'
    );
    const skillsRoot = resolveSkillsRoot();
    await recordBundledInstalls(skillsRoot, installed);
    const receipt = await pruneBundledSkills({
      bundledSkillsDir: join(ctSkillsRoot, 'skills'),
      skillsRoot,
      providerSkillDirs: providers.flatMap((p) => resolveProviderSkillsDirs(p, 'global')),
      registry: await defaultPruneRegistry(),
      receiptPath: join(skillsRoot, '.prune-receipts.jsonl'),
    });
    const moved = receipt.actions.filter((a) => a.action === 'quarantined');
    if (moved.length > 0) {
      created.push(
        `skills: quarantined ${moved.length} entries no longer installed (${[...new Set(moved.map((a) => a.name))].join(', ')}); restore with cleo skills doctor restore ${receipt.quarantineId}`,
      );
    }
    for (const e of receipt.errors) warnings.push(`Skill prune: ${e}`);
  } catch (err) {
    warnings.push(`Skill prune: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Options for {@link initNexusRegistration} (T12470). */
export interface InitNexusRegistrationOptions {
  /**
   * Maintenance caller (`cleo upgrade` / `self-update`): record an encounter
   * only — never mint an identity and never repoint an existing row.
   */
  maintenance?: boolean;
  /** Explicit rebind even though the previous location still exists. */
  forceRebind?: boolean;
}

/**
 * Register/reconcile project with NEXUS.
 * Uses nexusReconcile for idempotent handshake — auto-registers if new,
 * updates path if moved, confirms identity if unchanged.
 * @task T4684
 * @task T5368
 */
export async function initNexusRegistration(
  projectRoot: string,
  created: string[],
  warnings: string[],
  opts: InitNexusRegistrationOptions = {},
): Promise<void> {
  try {
    const { shouldAutoRegisterProject } = await import('./nexus/registry-hygiene.js');
    if (!shouldAutoRegisterProject(projectRoot, getCleoHome())) {
      // T12324: a temp/scratch project never lands in a persistent registry.
      warnings.push(
        'NEXUS registration skipped: project is under a temp directory (register explicitly with `cleo nexus register`)',
      );
      return;
    }
    if (opts.maintenance) {
      // T12470: a maintenance command (`cleo upgrade` / `self-update`) is not
      // an explicit registration. It goes through the encounter, which never
      // mints an identity and never moves an existing row to this checkout.
      const outcome = await recordProjectEncounter(projectRoot);
      if (outcome === 'recorded') created.push('NEXUS registration (encounter recorded)');
      return;
    }
    const { nexusReconcile } = await import('./nexus/registry.js');
    const result = await nexusReconcile(projectRoot, {
      ...(opts.forceRebind ? { forceRebind: true } : {}),
    });
    if (result.status === 'candidate') {
      warnings.push(
        `NEXUS registration: this project is registered at ${result.oldPath}, which still exists; ` +
          'this checkout was recorded as a candidate and the registry was NOT repointed. ' +
          'If this checkout should own the registration, run `cleo doctor project-identity --resolve` ' +
          'or re-run with `--force-rebind`.',
      );
      return;
    }
    if (result.status === 'auto_registered') {
      created.push('NEXUS registration (auto-registered new project)');
    } else if (result.status === 'path_updated') {
      created.push(`NEXUS registration (path updated: ${result.oldPath} → ${result.newPath})`);
    } else if (result.status === 'ok') {
      created.push('NEXUS registration (project verified and active)');
    }
  } catch (err) {
    const errStr = String(err);
    if (errStr.includes('NEXUS_PROJECT_EXISTS')) {
      warnings.push('NEXUS registration: Project already registered');
    } else if (errStr.includes('NEXUS_REGISTRY_CORRUPT')) {
      warnings.push(
        `NEXUS registration: Identity conflict - ${err instanceof Error ? err.message : errStr}. Run 'cleo nexus unregister' and re-register.`,
      );
    } else {
      warnings.push(`NEXUS registration: ${err instanceof Error ? err.message : errStr}`);
    }
  }
}

// ── GitHub Templates ─────────────────────────────────────────────────

/**
 * Install GitHub issue and PR templates to .github/ if a git repo exists
 * but .github/ISSUE_TEMPLATE/ is not yet present.
 *
 * Idempotent: skips files that already exist. Never overwrites existing
 * templates — the project owner's customisations take precedence.
 *
 * @param projectRoot  Absolute path to the project root.
 * @param created      Array to push "created: ..." log entries into.
 * @param skipped      Array to push "skipped: ..." log entries into.
 */
export async function installGitHubTemplates(
  projectRoot: string,
  created: string[],
  skipped: string[],
): Promise<void> {
  // Only apply when a .git directory is present (i.e. this is a git repo)
  if (!existsSync(join(projectRoot, '.git'))) {
    return;
  }

  const githubDir = join(projectRoot, '.github');
  const issueTemplateDir = join(githubDir, 'ISSUE_TEMPLATE');

  // Locate bundled templates shipped alongside the package
  const packageRoot = getPackageRoot();
  const templateSrcDir = join(packageRoot, 'templates', 'github');

  if (!existsSync(templateSrcDir)) {
    // Templates not bundled — skip silently (e.g. development builds)
    return;
  }

  // Ensure .github/ISSUE_TEMPLATE/ directory tree exists
  await mkdir(issueTemplateDir, { recursive: true });

  // ── ISSUE_TEMPLATE files ─────────────────────────────────────────
  const issueSrcDir = join(templateSrcDir, 'ISSUE_TEMPLATE');
  if (existsSync(issueSrcDir)) {
    const issueFiles = readdirSync(issueSrcDir);
    for (const file of issueFiles) {
      const dest = join(issueTemplateDir, file);
      if (existsSync(dest)) {
        skipped.push(`.github/ISSUE_TEMPLATE/${file}`);
        continue;
      }
      const content = readFileSync(join(issueSrcDir, file), 'utf-8');
      await writeFile(dest, content, 'utf-8');
      created.push(`.github/ISSUE_TEMPLATE/${file}`);
    }
  }

  // ── pull_request_template.md ─────────────────────────────────────
  const prTemplateSrc = join(templateSrcDir, 'pull_request_template.md');
  const prTemplateDest = join(githubDir, 'pull_request_template.md');
  if (existsSync(prTemplateSrc)) {
    if (existsSync(prTemplateDest)) {
      skipped.push('.github/pull_request_template.md');
    } else {
      const content = readFileSync(prTemplateSrc, 'utf-8');
      // T10368-audit-ok: init.pr-template
      await writeFile(prTemplateDest, content, 'utf-8');
      created.push('.github/pull_request_template.md');
    }
  }
}

// ── Handoff Redirect Stubs ───────────────────────────────────────────

/** Redirect stub content written in place of deprecated markdown handoff files. */
const HANDOFF_REDIRECT_STUB = `# STALE — DO NOT READ THIS FILE FOR STATE

**This file is deprecated as canonical state per T1593 (shipped in v2026.4.157).**

The current state of the project lives in **TASKS + BRAIN** — never in markdown.

## What you must do instead

\`\`\`bash
cleo briefing
\`\`\`

That command returns the structured handoff from the last session, next tasks ranked by
score, blocked tasks, memory context, and active epics — all from the canonical source.

## If you are seeing this and you ALREADY started reading instead of running \`cleo briefing\`

Stop. Run \`cleo briefing\`. The system has explicit instructions for the next orchestrator
that live in BRAIN memory, not in this file.

---

*This file deliberately contains no state. Reading it cannot mislead you. Run \`cleo briefing\`.*
`;

/**
 * Patterns for deprecated markdown handoff files that must be replaced with redirect stubs.
 * Matches files in the .cleo/agent-outputs/ directory whose names match the pattern.
 *
 * @task T1610
 */
const DEPRECATED_HANDOFF_PATTERNS = [/^NEXT-SESSION-HANDOFF\.md$/, /^HONEST-HANDOFF-.+\.md$/];

/**
 * Install redirect stubs over deprecated markdown handoff files.
 *
 * Replaces any `NEXT-SESSION-HANDOFF.md` or `HONEST-HANDOFF-*.md` files in
 * `.cleo/agent-outputs/` that still contain narrative state (i.e. are more
 * than the redirect stub itself). Files that are already stubs are left alone.
 *
 * This prevents fresh agents from reading stale markdown as canonical state
 * instead of running `cleo briefing`.
 *
 * Idempotent: calling multiple times is safe.
 *
 * @param projectRoot  Absolute path to the project root.
 * @param created      Array to push "replaced: ..." log entries into.
 *
 * @task T1610
 */
export async function installHandoffRedirectStubs(
  projectRoot: string,
  created: string[],
): Promise<void> {
  const agentOutputsDir = join(projectRoot, '.cleo', 'agent-outputs');

  if (!existsSync(agentOutputsDir)) {
    return;
  }

  let files: string[];
  try {
    files = readdirSync(agentOutputsDir);
  } catch {
    return;
  }

  for (const file of files) {
    const isDeprecated = DEPRECATED_HANDOFF_PATTERNS.some((re) => re.test(file));
    if (!isDeprecated) continue;

    const filePath = join(agentOutputsDir, file);
    let existing: string;
    try {
      existing = readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }

    // Already a stub if it contains the redirect marker and is short (< 2 KB)
    const isAlreadyStub =
      existing.includes('deliberately contains no state') && existing.length < 2048;

    if (!isAlreadyStub) {
      await writeFile(filePath, HANDOFF_REDIRECT_STUB, 'utf-8');
      created.push(`handoff-redirect-stub: ${file} (replaced with redirect-only stub)`);
    }
  }
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Canonicalize a path for identity comparison, tolerating a missing path.
 *
 * @param path - Absolute path.
 * @returns The realpath, or the resolved path when it cannot be read.
 */
function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * Report whether `child` lies strictly below `parent` (by canonical path).
 *
 * @param child - Candidate descendant.
 * @param parent - Candidate ancestor.
 * @returns `true` when `child` is inside `parent` and not equal to it.
 */
function isStrictlyInside(child: string, parent: string): boolean {
  const rel = relative(canonicalPath(parent), canonicalPath(child));
  return rel !== '' && !rel.startsWith('..') && !isAbsolutePath(rel);
}

/**
 * The CLEO project that encloses a gitlink checkout (submodule or
 * separate-git-dir), or `undefined` when none does (T12562 · T12558 round 5).
 *
 * The walk starts at the gitlink's PARENT directory, never at the checkout
 * itself: a `.cleo/` inside the checkout — tracked files, or the tombstone a
 * reroot leaves — must not make it look self-contained, because project-root
 * resolution walks past a gitlink root and would still use the enclosing
 * store. A relocation refusal met on the way up is not an enclosing project.
 *
 * @param gitlinkRoot - Root of the gitlink checkout (its `.git` is a file).
 * @returns The enclosing project root, or `undefined`.
 */
function enclosingProjectOfGitlink(gitlinkRoot: string): string | undefined {
  const parent = dirname(gitlinkRoot);
  if (parent === gitlinkRoot) return undefined;
  try {
    const root = getProjectRoot(parent);
    return existsSync(join(root, '.cleo')) && isStrictlyInside(gitlinkRoot, root)
      ? root
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Find the nearest git checkout boundary at or above `start`.
 *
 * @param start - Absolute directory to start from.
 * @returns The nearest boundary, or `null` when no `.git` entry exists above.
 */
function findGitBoundary(start: string): InitGitBoundary | null {
  let current = start;
  while (true) {
    const gitPath = join(current, '.git');
    try {
      const st = statSync(gitPath);
      if (st.isDirectory()) return { root: current, kind: 'repo' };
      if (st.isFile()) {
        // A linked worktree shares its main checkout's project; a submodule or
        // separate-git-dir gitlink is its own repository.
        if (!isGitLinkedCheckout(current)) return { root: current, kind: 'submodule' };
        const mainRoot = linkedWorktreeMainRoot(current);
        return { root: current, kind: 'worktree', ...(mainRoot ? { mainRoot } : {}) };
      }
    } catch {
      // No `.git` here — keep walking.
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * Choose the directory `cleo init` acts on (T12562).
 *
 * Every other command walks up from a subdirectory to the enclosing project,
 * and keeps doing so. `init` is different because it CREATES a project, so the
 * walk must not silently redirect it: from a child git repository nested under
 * an initialized CLEO root the walk found the parent, and the guard then
 * advised `--force` against the parent's store.
 *
 * Resolution order:
 * 1. `--here` targets the working directory ({@link initProject} still refuses
 *    it inside a linked worktree).
 * 2. An active worktree scope, an absolute `CLEO_DIR` or `CLEO_ROOT` /
 *    `CLEO_PROJECT_ROOT` pins the target explicitly (unchanged behaviour).
 * 3. A working directory that is its own git root (`.git` is a directory)
 *    targets itself: a nested repository is a separate project. A gitlink
 *    checkout (linked worktree, submodule, separate-git-dir) does not, because
 *    project-root resolution cannot use a store there.
 * 4. Otherwise the existing resolution applies. A plain (non-git)
 *    subdirectory of a CLEO project therefore still resolves to that ancestor;
 *    {@link initProject} reports it by absolute path and never wipes it.
 *
 * @param opts - `here` forces the working directory; `cwd` overrides `process.cwd()`.
 * @returns The chosen target.
 *
 * @example
 * ```ts
 * resolveInitTarget(); // { projectRoot: '/repo/child', source: 'git-root', isCwd: true, ... }
 * ```
 *
 * @task T12562
 */
export function resolveInitTarget(opts: { here?: boolean; cwd?: string } = {}): InitTarget {
  const cwd = resolve(opts.cwd ?? process.cwd()); // CWD-OK: init creates the project at cwd (T12562)
  const cleoDirEnv = getCleoDir();
  const relativeCleoDir = isAbsolutePath(cleoDirEnv) ? '.cleo' : cleoDirEnv;
  const envPinned =
    isAbsolutePath(cleoDirEnv) ||
    Boolean(process.env['CLEO_ROOT'] ?? process.env['CLEO_PROJECT_ROOT']);
  const pinned = envPinned || worktreeScope.getStore() !== undefined;
  const gitBoundary = findGitBoundary(cwd);

  let cleoDir: string;
  let source: InitTargetSource;
  if (opts.here) {
    cleoDir = resolve(cwd, relativeCleoDir);
    source = 'here';
  } else if (pinned) {
    // T9803/D009: `bootstrap` is the only sanctioned cwd-relative fallback.
    cleoDir = getCleoDirAbsolute(opts.cwd, { bootstrap: true });
    source = 'pinned';
  } else if (gitBoundary?.kind === 'repo' && gitBoundary.root === cwd) {
    cleoDir = resolve(cwd, relativeCleoDir);
    source = 'git-root';
  } else {
    cleoDir = getCleoDirAbsolute(opts.cwd, { bootstrap: true });
    source = 'resolved';
  }
  // `cleoDir` is `<root>/.cleo` by default, so its parent is the project root.
  // This also respects an absolute `CLEO_DIR` used by the init-e2e suite.
  const projectRoot = dirname(cleoDir);

  let enclosingProjectRoot: string | undefined;
  if (gitBoundary?.kind === 'submodule') {
    enclosingProjectRoot = enclosingProjectOfGitlink(gitBoundary.root);
  }
  return {
    cleoDir,
    projectRoot,
    cwd,
    source,
    isCwd: canonicalPath(projectRoot) === canonicalPath(cwd),
    envPinned,
    gitBoundary,
    ...(enclosingProjectRoot ? { enclosingProjectRoot } : {}),
  };
}

/**
 * Return the stable init refusal code carried by `err`, if any (T12562).
 *
 * @param err - Error thrown by core `initProject`.
 * @returns One of {@link INIT_ERROR_CODES}, or `undefined`.
 *
 * @example
 * ```ts
 * initErrorCodeName(err); // 'E_INIT_ANCESTOR_PROJECT'
 * ```
 *
 * @task T12562
 */
export function initErrorCodeName(err: unknown): string | undefined {
  if (!(err instanceof CleoError)) return undefined;
  const codeName = err.details?.['codeName'];
  const known: readonly string[] = Object.values(INIT_ERROR_CODES);
  return typeof codeName === 'string' && known.includes(codeName) ? codeName : undefined;
}

/**
 * Build a `cleo init` refusal carrying its stable code in `details.codeName`.
 *
 * @param codeName - One of {@link INIT_ERROR_CODES}.
 * @param message - Self-contained message; the CLI prints only this line.
 * @param fix - Copy-paste remedy.
 * @param details - Extra structured context.
 * @returns The error to throw.
 */
function initRefusal(
  codeName: (typeof INIT_ERROR_CODES)[keyof typeof INIT_ERROR_CODES],
  message: string,
  fix: string,
  details: Record<string, unknown>,
): CleoError {
  return new CleoError(ExitCode.GENERAL_ERROR, message, {
    fix,
    details: { field: 'cwd', codeName, ...details },
  });
}

/** What `--force` resets, stated once for every message that mentions it. */
const FORCE_RESETS =
  '--force resets .cleo/config.json and .cleo/project-info.json to defaults and rewrites ' +
  '.cleo/.gitignore and the managed git hooks (commit-msg, pre-commit, pre-push); it deletes ' +
  'no task, brain or conduit data. It first snapshots the databases (VACUUM INTO) and those ' +
  'files into .cleo/backups/sqlite/ and refuses if the snapshot fails.';

/**
 * Refuse any init that could touch a project other than the one the operator
 * is standing in (T12562). Every refusal changes nothing.
 *
 * @param target - The resolved target.
 * @param opts - The caller's init options.
 * @param alreadyInitialized - Whether the target already holds a project.
 * @throws {CleoError} With `details.codeName` from {@link INIT_ERROR_CODES}.
 */
function assertInitTargetAllowed(
  target: InitTarget,
  opts: InitOptions,
  alreadyInitialized: boolean,
): void {
  const { cwd, projectRoot: root, gitBoundary: git } = target;
  const additiveMapOnly = opts.mapCodebase === true && !opts.force;

  // A linked worktree shares its main checkout's project (D009 / T9803): a
  // `.cleo/` inside it is an orphan store. Only an explicit env pin, or the
  // additive map of the already-initialized main project, may proceed.
  if (git?.kind === 'worktree' && !target.envPinned) {
    const main = git.mainRoot;
    const mapsMain =
      main !== undefined &&
      additiveMapOnly &&
      alreadyInitialized &&
      canonicalPath(root) === canonicalPath(main);
    if (!mapsMain) {
      const whose = main ? ` of ${main}` : '';
      throw initRefusal(
        INIT_ERROR_CODES.inWorktree,
        `${cwd} is inside a linked git worktree${whose}. A worktree shares its main ` +
          `checkout's CLEO project, so there is nothing to init here, and a .cleo/ inside a ` +
          'worktree would be an orphan store. Nothing was changed.' +
          (main ? ` If ${main} is not a CLEO project yet, run \`cleo init\` there.` : ''),
        main
          ? `cd ${JSON.stringify(main)} && cleo init`
          : 'Run `cleo init` in the main checkout (`git worktree list` names it).',
        { resolvedRoot: root, worktreeRoot: git.root, ...(main ? { mainRoot: main } : {}) },
      );
    }
  }

  // A submodule / separate-git-dir checkout under a CLEO project: project-root
  // resolution walks past a gitlink root, so a store created here would be
  // ignored and every later command would use the superproject's store.
  const enclosing = target.enclosingProjectRoot;
  if (
    git?.kind === 'submodule' &&
    enclosing !== undefined &&
    !target.envPinned &&
    !(additiveMapOnly && !opts.here)
  ) {
    throw initRefusal(
      INIT_ERROR_CODES.gitlinkUnsupported,
      `${git.root} is a submodule / separate-git-dir checkout inside the CLEO project at ` +
        `${enclosing}. CLEO resolves this checkout to ${enclosing}, so every command run here ` +
        `already uses that project's store; a separate store for a gitlink checkout is not ` +
        'supported yet (tracked separately). Nothing was changed.',
      `Use the project at ${enclosing} (run cleo from anywhere inside it).`,
      { resolvedRoot: root, repositoryRoot: git.root, enclosingProjectRoot: enclosing },
    );
  }

  // An uninitialized repository between cwd and the ancestor project is the
  // project the operator most likely meant: point there, not at cwd.
  const nestedRepo =
    git?.kind === 'repo' && isStrictlyInside(git.root, root) ? git.root : undefined;
  // Never advise --force against a root other than cwd (T12562 AC2).
  const separateProjectFix = nestedRepo
    ? `cd ${JSON.stringify(nestedRepo)} && cleo init`
    : `cd ${JSON.stringify(cwd)} && cleo init --here`;

  if (opts.force && !target.isCwd) {
    throw initRefusal(
      INIT_ERROR_CODES.forceNotCwd,
      `Refusing --force: it would re-initialize ${root}, which is not the current directory ` +
        `(${cwd}). --force only ever acts on the current directory's own project. ` +
        'Nothing was changed.',
      separateProjectFix,
      { field: 'force', resolvedRoot: root },
    );
  }

  if (!alreadyInitialized || opts.force || additiveMapOnly) return;

  if (target.isCwd) {
    throw initRefusal(
      INIT_ERROR_CODES.alreadyInitialized,
      `Project already initialized at ${root}. DANGER ZONE: ${FORCE_RESETS}`,
      'cleo init --force',
      { resolvedRoot: root },
    );
  }

  if (nestedRepo) {
    throw initRefusal(
      INIT_ERROR_CODES.ancestorProject,
      `${cwd} is inside the git repository ${nestedRepo}, which is not a CLEO project yet; ` +
        `the nearest CLEO project is ${root}. Nothing was changed. To make that repository ` +
        `its own project, run \`cleo init\` in ${nestedRepo}.`,
      separateProjectFix,
      { resolvedRoot: root, repositoryRoot: nestedRepo },
    );
  }

  throw initRefusal(
    INIT_ERROR_CODES.ancestorProject,
    `${cwd} is inside the CLEO project already initialized at ${root}. Nothing was ` +
      `changed. To create a separate project in ${cwd}, run \`cleo init --here\` there.`,
    separateProjectFix,
    { resolvedRoot: root, source: target.source },
  );
}

/**
 * Every managed git hook a forced re-init could overwrite, as snapshot sources.
 *
 * `ensureGitHooks({ force })` writes `<root>/.git/hooks`. The hooks git
 * actually runs may live elsewhere (a gitlink checkout's git dir, or a custom
 * `core.hooksPath`), so that directory is resolved too and snapshotted when it
 * differs (T12562).
 *
 * @param projRoot - Absolute project root.
 * @returns `[label, sourcePath]` pairs for the snapshot.
 */
function managedHookSnapshotSources(projRoot: string): Array<[string, string]> {
  const literal = join(projRoot, '.git', 'hooks');
  const gitDir = resolveGitDir(projRoot);
  const effective = gitDir ? resolveHooksDir(projRoot, gitDir) : literal;
  const dirs: Array<[prefix: string, dir: string]> = [['git-hook', literal]];
  if (canonicalPath(effective) !== canonicalPath(literal)) dirs.push(['hooks-path', effective]);
  return dirs.flatMap(([prefix, dir]) =>
    MANAGED_HOOKS.map((h): [string, string] => [`${prefix}-${h}`, join(dir, h)]),
  );
}

/**
 * Snapshot everything a forced re-init overwrites, and refuse to continue
 * without a complete snapshot (T12562).
 *
 * Uses the `cleo backup add` path ({@link createBackup}): `VACUUM INTO` for the
 * databases and atomic copies of `config.json` / `project-info.json`, with a
 * restorable `<backupId>.meta.json` sidecar (`cleo restore backup`). The other
 * files `--force` rewrites (`.cleo/.gitignore`, `.cleo/project-context.json`,
 * the managed git hooks) are copied beside it as `<name>.<backupId>`.
 *
 * @param projRoot - Absolute project root being re-initialized.
 * @param cleoDir - Absolute `.cleo/` directory of that root.
 * @returns The backup id written by THIS run.
 * @throws {CleoError} `E_INIT_SNAPSHOT_FAILED` when any required file is missing
 *   from this run's snapshot.
 */
async function snapshotBeforeForcedReinit(projRoot: string, cleoDir: string): Promise<string> {
  const { createBackup, PROJECT_STORE_BACKUP_FILE } = await import('./system/backup.js');
  const result = await createBackup(projRoot, {
    type: 'pre-force-init',
    note: 'taken by `cleo init --force` before it resets project files (T12562)',
  });
  const required = ['config.json', 'project-info.json'].filter((f) => existsSync(join(cleoDir, f)));
  // createBackup's copy of the live project store (T13245: one `cleo.db`).
  if (existsSync(join(cleoDir, 'cleo.db')) || existsSync(join(cleoDir, 'tasks.db'))) {
    required.push(PROJECT_STORE_BACKUP_FILE);
  }
  const missing = required.filter((f) => !result.files.includes(f));

  const extras: Array<[label: string, src: string]> = [
    ['.gitignore', join(cleoDir, '.gitignore')],
    ['project-context.json', join(cleoDir, 'project-context.json')],
    ...managedHookSnapshotSources(projRoot),
  ];
  for (const [label, src] of extras) {
    if (!existsSync(src)) continue;
    try {
      copyFileSync(
        src,
        join(result.path, `${label}.${result.backupId}`),
        fsConstants.COPYFILE_EXCL,
      );
    } catch {
      missing.push(label);
    }
  }

  if (missing.length > 0) {
    throw initRefusal(
      INIT_ERROR_CODES.snapshotFailed,
      `Refusing --force: the pre-reset snapshot of ${projRoot} is incomplete (missing: ` +
        `${missing.join(', ')}). Nothing was changed. Run \`cleo backup add\`, then retry.`,
      'cleo backup add',
      { field: 'force', resolvedRoot: projRoot, missing, backupId: result.backupId },
    );
  }
  return result.backupId;
}

/**
 * Run update-docs only: refresh all injections without reinitializing.
 * Re-injects CLEO-INJECTION.md into all detected agent instruction files.
 *
 * @task T4686
 */
export async function updateDocs(): Promise<InitResult> {
  const cleoDir = resolveCleoDir();
  const projRoot = getProjectRoot();
  const created: string[] = [];
  const warnings: string[] = [];

  // Re-inject into all provider instruction files (and AGENTS.md hub)
  try {
    const result = await ensureInjection(projRoot);
    if (result.action !== 'skipped') {
      created.push(`injection: ${result.details ?? result.action}`);
    }
  } catch (err) {
    warnings.push(`CAAMP injection: ${err instanceof Error ? err.message : String(err)}`);
  }

  return {
    initialized: true,
    directory: cleoDir,
    created,
    skipped: [],
    warnings,
    updateDocsOnly: true,
  };
}

/**
 * Remove the identity files a relocated project left (or `git checkout`
 * restored) at `root`, so `cleo init --here --new-identity` mints a new id
 * instead of adopting the old one: `.cleo/project.json`, `.cleo/project-id`
 * and `.cleo/project-info.json` only when they declare `projectId`, and the
 * reroot tombstone. Nothing else is touched.
 */
async function retireRelocatedIdentity(root: string, projectId: string): Promise<void> {
  const { readProjectIdFile, readProjectManifest } = await import('@cleocode/paths');
  const manifest = readProjectManifest(root);
  if (manifest.status === 'valid' && manifest.manifest.id === projectId) {
    await unlink(join(root, '.cleo', 'project.json'));
  }
  const tracked = readProjectIdFile(root);
  if (tracked.status === 'valid' && tracked.projectId === projectId) {
    await unlink(join(root, '.cleo', 'project-id'));
  }
  const infoPath = join(root, '.cleo', 'project-info.json');
  if (existsSync(infoPath)) {
    try {
      const info = JSON.parse(await readFile(infoPath, 'utf-8')) as { projectId?: unknown };
      if (info.projectId === projectId) await unlink(infoPath);
    } catch {
      // Unparseable: ensureProjectInfo regenerates it.
    }
  }
  const { PROJECT_TOMBSTONE_FILE } = await import('./project-tombstone.js');
  await unlink(join(root, PROJECT_TOMBSTONE_FILE)).catch(() => undefined);
}

/**
 * Run full project initialization.
 *
 * Creates the .cleo/ directory structure, installs schemas, templates,
 * agent definitions, skills, and registers with NEXUS.
 *
 * @task T4681
 * @task T4682
 * @task T4684
 * @task T4685
 * @task T4686
 * @task T4687
 * @task T4689
 * @task T4706
 * @task T4707
 */
export async function initProject(opts: InitOptions = {}): Promise<InitResult> {
  // T12562: choose the target explicitly instead of trusting the ancestor
  // walk. From a child git repo under an initialized CLEO root the walk
  // resolved the PARENT, the guard below then advised `--force`, and following
  // that advice re-initialized the parent store.
  const target = resolveInitTarget({ here: opts.here });
  const { cleoDir, projectRoot: projRoot } = target;

  // T12558: relocation state, detected WITHOUT writing or throwing yet.
  // Resolving from the target reports E_PROJECT_MOVED at a valid reroot
  // tombstone (at the target or an ancestor it would resolve to); the store
  // guard's registry arm is checked up front for the same reason.
  let movedOnResolve: CleoError | undefined;
  if (!opts.here) {
    try {
      getProjectRoot(projRoot);
    } catch (err) {
      if (err instanceof CleoError && err.code === ExitCode.PROJECT_MOVED) movedOnResolve = err;
    }
  }
  const { detectRelocatedRoot, allowStoreAtRelocatedRoot } = await import(
    './store/relocated-store-guard.js'
  );
  const { resolveDualScopeDbPath } = await import('./store/dual-scope-db.js');
  const relocated = existsSync(join(cleoDir, 'cleo.db'))
    ? null
    : detectRelocatedRoot(projRoot, resolveDualScopeDbPath('global'));

  // T12562: legacy `tasks.db` counts too, so a forced re-init snapshots it.
  // T12558: at a relocated root (no store) restored tracked files never count,
  // so #1605's guard never answers "already initialized — use --force" there.
  const alreadyInitialized =
    !relocated &&
    existsSync(cleoDir) &&
    (existsSync(join(cleoDir, 'cleo.db')) ||
      existsSync(join(cleoDir, 'tasks.db')) ||
      existsSync(join(cleoDir, 'config.json')));

  // #1605's target refusals (worktree, gitlink, force-not-cwd, ancestor) run
  // FIRST: a relocation opt-out can never reopen a target CLEO cannot use.
  assertInitTargetAllowed(target, opts, alreadyInitialized);

  // T12558: relocation refusals, still before any write.
  if (movedOnResolve) throw movedOnResolve;
  if (relocated && !opts.here) {
    const { projectMovedError } = await import('./project-tombstone.js');
    throw projectMovedError(projRoot, relocated, undefined, relocated.via);
  }
  // `--here` alone would ADOPT the relocated project's id and create a SECOND
  // store for it — two diverging copies of one project. Only a genuinely
  // separate project (a new id) may start here.
  if (relocated && !opts.newIdentity) {
    throw new CleoError(
      ExitCode.PROJECT_MOVED,
      `E_PROJECT_MOVED: ${projRoot} is where project ${relocated.projectId} was rerooted from; \`--here\` alone would create a second store for that same project`,
      {
        fix: `cd "${relocated.movedTo}" (the live project). To start a DIFFERENT project here, run \`cleo init --here --new-identity\` (mints a new id; commit the new .cleo/project.json and .cleo/project-id).`,
        details: {
          field: 'projectRoot',
          projectId: relocated.projectId,
          movedFrom: projRoot,
          movedTo: relocated.movedTo,
          evidence: relocated.via,
        },
      },
    );
  }

  // T12558: `--here --new-identity` at a relocated root — every refusal has
  // passed. The restored `.cleo/project-id` (and a stale tombstone) belong to
  // the relocated project; retire them so a new id is minted, not adopted.
  let retiredProjectId: string | undefined;
  if (relocated) {
    allowStoreAtRelocatedRoot(projRoot);
    retiredProjectId = relocated.projectId;
    await retireRelocatedIdentity(projRoot, relocated.projectId);
    const auditPath = join(cleoDir, 'audit', 'relocation-override.jsonl');
    await mkdir(dirname(auditPath), { recursive: true });
    await appendFile(
      auditPath,
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        action: 'init --here --new-identity',
        projectRoot: projRoot,
        projectId: relocated.projectId,
        movedTo: relocated.movedTo,
        evidence: relocated.via,
        newIdentity: true,
      })}\n`,
    );
  }

  const force = !!opts.force;
  const scope = captureProjectScope(projRoot, worktreeScope.getStore());

  let preForceBackupId: string | undefined;
  if (force && alreadyInitialized) {
    preForceBackupId = await worktreeScope.run(scope, () =>
      snapshotBeforeForcedReinit(projRoot, cleoDir),
    );
  }

  // Pin every ambient `getProjectRoot()` / `getCleoDirAbsolute()` inside the
  // scaffolding steps to the chosen target, so none of them walks back up to
  // an ancestor project while the target's `.cleo/` is still being created.
  return worktreeScope.run(scope, () =>
    scaffoldInitTarget(opts, { cleoDir, projRoot, force, preForceBackupId, retiredProjectId }),
  );
}

/**
 * Run the scaffolding half of {@link initProject} against an already-chosen,
 * already-guarded target.
 *
 * @param opts - The caller's init options.
 * @param target - Resolved `.cleo/` directory, project root, force flag and pre-force backup id.
 * @returns The init result.
 */
async function scaffoldInitTarget(
  opts: InitOptions,
  target: {
    cleoDir: string;
    projRoot: string;
    force: boolean;
    preForceBackupId?: string;
    /** Id retired by `--here --new-identity` at a relocated root (T12558). */
    retiredProjectId?: string;
  },
): Promise<InitResult> {
  const { cleoDir, projRoot, force, retiredProjectId } = target;
  const created: string[] = [];
  if (target.preForceBackupId) {
    created.push(
      `pre-force snapshot: .cleo/backups/sqlite/*.${target.preForceBackupId} (cleo restore backup)`,
    );
  }
  const skipped: string[] = [];
  const warnings: string[] = [];

  // Phase 5 — classify the directory BEFORE creating any files so the
  // classification reflects the real pre-init state of the directory.
  let classification: ProjectClassification | undefined;
  try {
    classification = classifyProject(projRoot);
  } catch (err) {
    warnings.push(
      `Project classification failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // T4681: Create .cleo/ directory structure
  const structureResult = await ensureCleoStructure(projRoot);
  if (structureResult.action === 'created') {
    created.push('.cleo/ directory structure');
  }

  // T4681: Create config.json
  const configResult = await ensureConfig(projRoot, { force });
  if (configResult.action === 'skipped') {
    skipped.push('config.json');
  } else {
    created.push('config.json');
  }

  // Initialize SQLite database (tasks, sessions, archive, audit log all live here)
  try {
    const { getDb } = await import('./store/sqlite.js');
    await getDb(join(cleoDir, '..'));
    created.push('tasks.db');
  } catch (err) {
    // A relocated root is a refusal, never a store "deferred" behind success.
    if (err instanceof CleoError && err.code === ExitCode.PROJECT_MOVED) throw err;
    // SQLite init failure is not fatal — will be created on first access
    created.push(`tasks.db (deferred: ${err instanceof Error ? err.message : String(err)})`);
  }

  // Initialize brain.db for BRAIN memory system
  try {
    const brainResult = await ensureBrainDb(projRoot);
    if (brainResult.action === 'created') {
      created.push('brain.db');
    }
  } catch (err) {
    created.push(`brain.db (deferred: ${err instanceof Error ? err.message : String(err)})`);
  }

  // Initialize conduit.db for project-tier agent messaging infrastructure.
  // T310 (v2026.4.12) moved project-tier messaging from signaldock.db to
  // conduit.db; global agent identity continues to live in the global
  // signaldock.db, which the CLI startup sequence ensures separately.
  try {
    const { ensureConduitDb } = await import('./store/conduit-sqlite.js');
    const cdResult = await ensureConduitDb(projRoot);
    if (cdResult.action === 'created') {
      created.push('conduit.db');
    }
  } catch (err) {
    // Non-fatal — conduit.db will be created on first agent operation
    created.push(`conduit.db (deferred: ${err instanceof Error ? err.message : String(err)})`);
  }

  // T4681: Create .cleo/.gitignore (respect force flag)
  if (force) {
    // When force is set, always overwrite — ensureGitignore does content-comparison only
    const gitignoreResult = await ensureGitignore(projRoot);
    if (gitignoreResult.action === 'skipped') {
      skipped.push('.gitignore');
    } else {
      created.push('.gitignore');
    }
  } else {
    const gitignorePath = join(cleoDir, '.gitignore');
    if (existsSync(gitignorePath)) {
      skipped.push('.gitignore');
    } else {
      const gitignoreResult = await ensureGitignore(projRoot);
      if (gitignoreResult.action !== 'skipped') {
        created.push('.gitignore');
      } else {
        skipped.push('.gitignore');
      }
    }
  }

  // Create canonical .worktreeinclude at the project root (T9983).
  // The legacy .cleo/worktree-include is read for one deprecation cycle by
  // `@cleocode/worktree` and migrated explicitly via
  // `cleo doctor --migrate-worktree-include`.
  try {
    const worktreeIncludeResult = await ensureWorktreeInclude(projRoot);
    if (worktreeIncludeResult.action !== 'skipped') {
      created.push('.worktreeinclude');
    }
  } catch (err) {
    warnings.push(
      `.worktreeinclude creation failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Remove legacy sequence files if they exist (migration)
  const legacySequencePath = join(cleoDir, '.sequence');
  try {
    await unlink(legacySequencePath);
  } catch {
    /* ignore if absent */
  }
  const legacySequenceJsonPath = join(cleoDir, '.sequence.json');
  try {
    await unlink(legacySequenceJsonPath);
  } catch {
    /* ignore if absent */
  }

  // T4872: Isolated .cleo/.git checkpoint repository
  try {
    const gitRepoResult = await ensureCleoGitRepo(projRoot);
    if (gitRepoResult.action === 'created') {
      created.push('.cleo/.git (isolated checkpoint repository)');
    }
  } catch (err) {
    warnings.push(
      `Could not initialize .cleo/.git: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // T1244: Materialize an empty initial commit on the project's git repo when
  // HEAD is unborn. Without this, `cleo orchestrate spawn` cannot resolve the
  // base ref and falls back to a no-isolation worktree with a WARN.
  // Idempotent — does nothing when HEAD already points at a commit.
  try {
    const initialCommitResult = await ensureProjectGitInitialCommit(projRoot);
    if (initialCommitResult.action === 'created') {
      created.push('git: empty initial commit (so HEAD resolves for worktree provisioning)');
    } else if (
      initialCommitResult.action === 'skipped' &&
      initialCommitResult.details &&
      initialCommitResult.details.startsWith('Could not create')
    ) {
      warnings.push(initialCommitResult.details);
    }
  } catch (err) {
    warnings.push(
      `Initial commit step failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // T4700: Migrate legacy agent-output directories before proceeding
  try {
    const migrationResult = migrateAgentOutputs(projRoot, cleoDir);
    if (migrationResult.migrated) {
      created.push(`agent-outputs migration: ${migrationResult.summary}`);
    }
  } catch {
    warnings.push('Agent-outputs migration failed (best-effort, run cleo upgrade to retry)');
  }

  // T4681: Schema files (~/.cleo/schemas/)
  try {
    const schemaResult = ensureGlobalSchemas({ force });
    const total = schemaResult.installed + schemaResult.updated;
    if (total > 0) {
      created.push(`schemas/ (${total} files)`);
    }
  } catch (err) {
    warnings.push(`Schema installation: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Git hooks (commit-msg, pre-commit, pre-push)
  try {
    const hooksResult = await ensureGitHooks(projRoot, { force });
    if (hooksResult.action === 'created') {
      created.push(hooksResult.details ?? 'git hooks installed');
    } else if (hooksResult.action === 'skipped' && hooksResult.details?.includes('No .git/')) {
      warnings.push(hooksResult.details);
    } else if (
      hooksResult.action === 'skipped' &&
      hooksResult.details?.includes('not found in package root')
    ) {
      warnings.push(hooksResult.details);
    } else if (hooksResult.action === 'repaired' && hooksResult.details?.includes('error')) {
      // Hook errors reported via details in 'repaired' action
      const match = hooksResult.details.match(/Installed (\d+)/);
      if (match && parseInt(match[1], 10) > 0) {
        created.push(`git hooks (${match[1]} installed)`);
      }
      warnings.push(hooksResult.details);
    }
  } catch (err) {
    warnings.push(`Git hook installation: ${err instanceof Error ? err.message : String(err)}`);
  }

  // T4684: Project info (.cleo/project-info.json)
  // T12325 · T12716: a project with no tracked identity records its id in the
  // tracked write-once .cleo/project.json (+ the legacy .cleo/project-id
  // mirror); re-links, conflicts, a legacy-only project (migrated only by
  // `cleo doctor project-identity --resolve`) and missing registry coverage
  // are reported, not hidden.
  const projectInfoResult = await ensureProjectInfo(projRoot, {
    force,
    mintNewIdentity: opts.newIdentity,
  });
  if (projectInfoResult.action === 'skipped') {
    skipped.push('project-info.json');
  } else {
    created.push('project-info.json');
  }
  if (
    projectInfoResult.details &&
    /re-linked|conflict|invalid|coverage missing|tracked identity legacy/.test(
      projectInfoResult.details,
    )
  ) {
    warnings.push(
      `Project identity: ${projectInfoResult.details}${
        projectInfoResult.details.includes('tracked identity legacy')
          ? '. Migrate to .cleo/project.json: `cleo doctor project-identity --resolve --dry-run`, then `--resolve`'
          : ''
      }`,
    );
  }
  if (retiredProjectId) {
    warnings.push(
      `The tracked identity changed: this is a NEW project, not ${retiredProjectId} (which lives on elsewhere). Commit the new .cleo/project.json and .cleo/project-id.`,
    );
    // Both projects are registered under this directory's name; say so rather
    // than rename either one behind the operator's back.
    warnings.push(
      `Project name "${basename(projRoot)}" is now ambiguous: ${retiredProjectId} was registered under the same name. Rename this one with \`cleo project rename <new-name>\`.`,
    );
  }

  // Project context detection (always run during init)
  try {
    const detectResult = await ensureProjectContext(projRoot, { force: !!opts.detect });
    if (detectResult.action !== 'skipped') {
      created.push('project-context.json');
      // T13125: the affected-scope command tool:test will derive, proposed.
      if (detectResult.details) created.push(`affected test scope: ${detectResult.details}`);
    }
  } catch (err) {
    warnings.push(`Project detection failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Codebase analysis and brain.db storage (brownfield auto-mapping)
  if (opts.mapCodebase) {
    try {
      const { mapCodebase } = await import('./codebase-map/index.js');
      const mapResult = await mapCodebase(projRoot, { storeToBrain: true });
      created.push(
        `codebase-map: ${mapResult.stack.languages.length} languages, ${mapResult.architecture.layers.length} layers analyzed`,
      );
    } catch (err) {
      warnings.push(`Codebase mapping: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Generate memory-bridge.md from brain.db BEFORE injection so AGENTS.md can reference it
  try {
    const bridgeResult = await writeMemoryBridge(projRoot);
    if (bridgeResult.written) {
      created.push('memory-bridge.md');
    }
  } catch (err) {
    warnings.push(`Memory bridge: ${err instanceof Error ? err.message : String(err)}`);
  }

  // T4682: Inject into agent instruction files via CAAMP (AGENTS.md hub pattern)
  try {
    const injectionResult = await ensureInjection(projRoot);
    if (injectionResult.action !== 'skipped') {
      // Parse the details to get individual file actions for backward-compatible output
      if (injectionResult.details) {
        created.push(`injection: ${injectionResult.details}`);
      }
    } else if (injectionResult.details) {
      warnings.push(injectionResult.details);
    }
  } catch (err) {
    warnings.push(`CAAMP injection: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ADR-029: Contributor project dev channel setup
  try {
    const { ensureContributorMcp } = await import('./scaffold.js');
    const devResult = await ensureContributorMcp(projRoot);
    if (devResult.action !== 'skipped') {
      created.push(`contributor dev channel: ${devResult.details ?? devResult.action}`);
    }
  } catch (err) {
    warnings.push(`Contributor dev channel: ${err instanceof Error ? err.message : String(err)}`);
  }

  // T4685: Agent definition (cleo-subagent)
  await initAgentDefinition(created, warnings);

  // Note: Core skills installation is global-only (bootstrapGlobalCleo / installSkillsGlobally).
  // Skills are NOT installed during project-level init — they are installed once globally.

  // T4684: NEXUS registration (reconcile-based handshake, T5368)
  await initNexusRegistration(projRoot, created, warnings, {
    ...(opts.forceRebind ? { forceRebind: true } : {}),
  });

  // T13128: the adapter discovery/install step was removed. Its discovery read
  // `<project>/packages/adapters/<dir>/manifest.json`, which no project has, so
  // it never ran; repaired, it would have written the user-global
  // `~/.claude/settings.json`. Provider hooks are delivered per project below.

  // T13124: the heavy-command hook (T12983), synced per provider. Writes are
  // listed as created;
  // a provider in use whose hook could not be put in place is a warning.
  try {
    const { deliverHeavyCommandHooks, heavyHookReportLines } = await import(
      './resources/heavy-command-hook-delivery.js'
    );
    const { outcomes } = await deliverHeavyCommandHooks(projRoot);
    for (const line of heavyHookReportLines(outcomes)) {
      if (line.status === 'applied') created.push(line.details);
      else warnings.push(`${line.reason ?? line.details}${line.fix ? ` Remedy: ${line.fix}` : ''}`);
    }
  } catch (err) {
    warnings.push(
      `heavy-command hook delivery failed: ${err instanceof Error ? err.message : String(err)}. Remedy: cleo doctor heavy-command-hook --fix`,
    );
  }

  // GitHub issue/PR templates (.github/ directory)
  try {
    await installGitHubTemplates(projRoot, created, skipped);
  } catch (err) {
    warnings.push(`GitHub templates: ${err instanceof Error ? err.message : String(err)}`);
  }

  // T1610: Replace deprecated markdown handoff files with redirect stubs.
  // Prevents fresh agents from reading stale markdown instead of running `cleo briefing`.
  try {
    await installHandoffRedirectStubs(projRoot, created);
  } catch (err) {
    warnings.push(`Handoff redirect stubs: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Remove .cleo/ from root .gitignore if present
  const rootGitignoreResult = await removeCleoFromRootGitignore(projRoot);
  if (rootGitignoreResult.removed) {
    warnings.push(
      '.cleo/ was found in root .gitignore and has been removed. CLEO uses .cleo/.gitignore for selective tracking.',
    );
  }

  // T441: Deploy starter CANT bundle (team + agents) to project-tier .cleo/cant/
  // This gives the CANT bridge a working team topology on first `cleoos` run.
  // Only deploys if .cleo/cant/ does not already contain .cant files (idempotent).
  try {
    await deployStarterBundle(cleoDir, created, warnings);
  } catch (err) {
    warnings.push(`Starter bundle deploy: ${err instanceof Error ? err.message : String(err)}`);
  }

  // T1934 / ADR-068: Register all 5 worker templates from @cleocode/agents/templates/
  // directly into signaldock.db.agents at project tier. This replaces the old two-step
  // flow (deployStarterBundle copies files → forceInstallProjectTierAgents registers them)
  // with a single atomic pass that writes both the .cant file and the DB row per template.
  // Force semantics ensure stale rows from prior init runs are overwritten (idempotent).
  try {
    const templateResult = await installTemplatesAtProjectTier(projRoot);
    if (templateResult.installed.length > 0) {
      created.push(
        `agents: registered ${templateResult.installed.length} project-tier worker templates`,
      );
    }
    for (const failure of templateResult.failed) {
      warnings.push(`agent template install failed (${failure.cantPath}): ${failure.error}`);
    }
    if (templateResult.templatesDir === null) {
      warnings.push(
        'project-tier agent templates not found — ensure @cleocode/agents is installed',
      );
    }
  } catch (err) {
    warnings.push(
      `project-tier template registration failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // T1242 (legacy): Force-reinstall any .cant files already on disk in .cleo/cant/agents/.
  // Handles brownfield projects that had agents deployed by a prior init before T1934.
  // New greenfield installs will have zero files here and this is a no-op.
  try {
    const { forceInstallProjectTierAgents } = await import('./agents/seed-install.js');
    const installResult = await forceInstallProjectTierAgents(projRoot);
    if (installResult.installed.length > 0) {
      created.push(
        `agents: registered ${installResult.installed.length} legacy project-tier .cant agents`,
      );
    }
    for (const failure of installResult.failed) {
      warnings.push(`agent install failed (${failure.cantPath}): ${failure.error}`);
    }
  } catch (err) {
    warnings.push(
      `project-tier agent registration failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // T283 / T1272 / T1934: --install-seed-agents is now a deprecated no-op alias.
  // All 5 worker templates are auto-registered above on every plain `cleo init`.
  // The flag is preserved for one minor release to avoid breaking existing scripts.
  if (opts.installSeedAgents) {
    pushWarning({
      code: 'W_DEPRECATED_AGENT_PATH',
      message:
        '--install-seed-agents is no longer required. ' +
        'All worker templates are now auto-registered on plain `cleo init` (T1934 / ADR-068). ' +
        'This flag will be removed in a future release.',
      deprecated: '--install-seed-agents',
    });
  }

  // ────────────────────────────────────────────────────────────────────
  // Phase 5 — Finalize classification report + CleoOS hub bootstrap
  // (Classification already ran at the TOP of init, before file creation)
  // ────────────────────────────────────────────────────────────────────
  if (classification) {
    created.push(
      `classification: ${classification.kind} (${classification.signals.length} signals)`,
    );
  }

  // Ensure the CleoOS Hub exists globally (idempotent — only writes once)
  try {
    const hubResult = await ensureCleoOsHub();
    if (hubResult.action === 'created') {
      created.push(`cleoos-hub: ${hubResult.details ?? 'scaffolded'}`);
    }
  } catch (err) {
    warnings.push(
      `CleoOS hub scaffold failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // E8 (T11734): seed the models_catalog SSoT from the shipped OFFLINE seed
  // (`curated-catalog.json`). Idempotent + version-skipped — no network. Catalog
  // becomes the resolver-default source (T11944), killing the hardcoded model.
  // Non-fatal: a fresh/offline install still resolves from the shipped seed floor.
  try {
    const { seedModelsCatalog } = await import('./llm/catalog-seeder.js');
    const seedResult = await seedModelsCatalog();
    if (seedResult.seeded) {
      created.push(`models-catalog: seeded ${seedResult.rowCount} models (v${seedResult.version})`);
    }
  } catch (err) {
    warnings.push(
      `models_catalog seed failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // M3 (T11703): seed the `providers` declarative-provider SSoT from the builtin
  // ProviderDef set (derived from the in-process ProviderProfile builtins). Idempotent
  // (upsert on `id`) + plugin-safe (never touches user provider rows) — no network.
  // Non-fatal: a fresh install still resolves providers from the in-process registry.
  try {
    const { seedProviders } = await import('./llm/provider-registry/provider-seed.js');
    const seedResult = await seedProviders();
    if (seedResult.seeded) {
      created.push(`providers: seeded ${seedResult.rowCount} builtin providers`);
    }
  } catch (err) {
    warnings.push(`providers seed failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Context anchoring: when brownfield and --map-codebase was NOT already run,
  // surface a hint so the operator knows they can anchor the baseline in BRAIN.
  // (We do NOT auto-run mapCodebase here — it's opt-in to avoid blocking init.)
  if (classification?.kind === 'brownfield' && !opts.mapCodebase) {
    warnings.push(
      'Brownfield detected — run `cleo init --map-codebase` to anchor the existing codebase in BRAIN (Phase 5 context anchoring).',
    );
  }

  // LAFS next-step guidance for autonomous agents
  const nextSteps: Array<{ action: string; command: string }> =
    classification?.kind === 'greenfield'
      ? [
          {
            action: 'Start the session and record your first research findings',
            command: 'cleo session start --scope global',
          },
          {
            action: 'Create the seed epic for Vision/PRD research',
            command: 'cleo add "Project vision and initial scope" --type epic',
          },
          {
            action: 'Invoke the Conductor Loop once the seed epic is present',
            command: 'pi /cleo:auto <seedEpicId>',
          },
        ]
      : [
          {
            action: 'Anchor the existing codebase in BRAIN as baseline context',
            command: 'cleo init --map-codebase',
          },
          {
            action: 'Review the detected project context',
            command: 'cleo admin paths',
          },
          {
            action: 'Start a session scoped to the work you want to continue',
            command: 'cleo session start --scope global',
          },
        ];

  // T1263 PSYCHE E6: Read recent session journals for meta-agent context (best-effort)
  let sessionContext: InitResult['sessionContext'];
  try {
    const { readRecentJournals } = await import('./sessions/session-journal.js');
    const recentJournals = await readRecentJournals(projRoot, 20, 5);
    if (recentJournals.length > 0) {
      sessionContext = { recentJournals };
    }
  } catch {
    // Journal reading is best-effort — never block init
  }

  return {
    initialized: true,
    directory: cleoDir,
    created,
    skipped,
    warnings,
    classification: classification
      ? {
          kind: classification.kind,
          signalCount: classification.signals.length,
          topLevelFileCount: classification.topLevelFileCount,
          hasGit: classification.hasGit,
        }
      : undefined,
    nextSteps,
    ...(sessionContext !== undefined ? { sessionContext } : {}),
  };
}

/**
 * Check if auto-init is enabled via environment variable.
 * @task T4789
 */
export function isAutoInitEnabled(): boolean {
  return process.env.CLEO_AUTO_INIT === 'true';
}

/**
 * Check if a project is initialized and auto-init if configured.
 * Returns { initialized: true } if ready, throws otherwise.
 * @task T4789
 */
export async function ensureInitialized(projectRoot?: string): Promise<{ initialized: boolean }> {
  const root = projectRoot ?? getProjectRoot();
  const cleoDir = join(root, '.cleo');
  const isInit =
    existsSync(cleoDir) &&
    (existsSync(join(cleoDir, 'tasks.db')) || existsSync(join(cleoDir, 'config.json')));

  if (isInit) {
    return { initialized: true };
  }

  if (isAutoInitEnabled()) {
    await initProject({ name: basename(root) });
    return { initialized: true };
  }

  throw new Error('CLEO project not initialized. Run system.init or set CLEO_AUTO_INIT=true');
}

/**
 * Get the current CLEO/project version.
 * Checks VERSION file, then package.json.
 * @task T4789
 */
export async function getVersion(projectRoot?: string): Promise<{ version: string }> {
  const root = projectRoot ?? getProjectRoot();

  // Try VERSION file
  const versionPaths = [join(root, 'VERSION'), join(root, '..', 'VERSION')];

  for (const versionPath of versionPaths) {
    try {
      const content = await readFile(versionPath, 'utf-8');
      const version = content.trim();
      if (version) {
        return { version };
      }
    } catch {
      // Try next path
    }
  }

  // Fallback: package.json
  const pkg = await readJson<{ version: string }>(join(root, 'package.json'));
  if (pkg?.version) {
    return { version: pkg.version };
  }

  return { version: '0.0.0' };
}

// ---------------------------------------------------------------------------
// Starter bundle deployment (T441) — shared between init and upgrade
// ---------------------------------------------------------------------------

/**
 * Deploy the starter CANT bundle (team + agents) to a project's `.cleo/cant/`.
 *
 * Idempotent: skips deployment if `.cleo/cant/` already contains `.cant` files.
 * Does not overwrite existing files. Resolves the starter bundle via the
 * {@link resolveStarterBundle} SDK helper — per D035 (v2026.4.111) the bundle
 * lives in `@cleocode/agents/starter-bundle/` rather than
 * `@cleocode/cleo-os/starter-bundle/`.
 *
 * Called by both `initProject()` and `runUpgrade()` to ensure every project
 * gets a working team topology for the CANT bridge.
 *
 * @param cleoDir - Absolute path to the project's `.cleo/` directory.
 * @param created - Array to push created-file descriptions into.
 * @param warnings - Array to push warning messages into.
 */
export async function deployStarterBundle(
  cleoDir: string,
  created: string[],
  warnings: string[],
): Promise<void> {
  const cantDir = join(cleoDir, 'cant');
  const cantAgentsDir = join(cantDir, 'agents');
  const hasCantFiles =
    existsSync(cantDir) &&
    readdirSync(cantDir, { recursive: true }).some(
      (f) => typeof f === 'string' && f.endsWith('.cant'),
    );

  if (hasCantFiles) return; // Already deployed — idempotent

  // Resolve the agent templates via the core SDK helper (T1935 / ADR-068).
  const { resolveAgentTemplates } = await import('./agents/resolveAgentTemplates.js');
  const starterBundleSrc = resolveAgentTemplates();

  if (!starterBundleSrc) {
    warnings.push(
      'Agent templates not found — .cleo/cant/ will remain empty. Ensure @cleocode/agents is installed.',
    );
    return;
  }

  await mkdir(cantDir, { recursive: true });
  await mkdir(cantAgentsDir, { recursive: true });

  // Copy team.cant
  const teamSrc = join(starterBundleSrc, 'team.cant');
  const teamDst = join(cantDir, 'team.cant');
  if (existsSync(teamSrc) && !existsSync(teamDst)) {
    await copyFile(teamSrc, teamDst);
  }

  // Copy agent .cant files
  const agentsSrc = join(starterBundleSrc, 'agents');
  if (existsSync(agentsSrc)) {
    const agentFiles = readdirSync(agentsSrc).filter((f) => f.endsWith('.cant'));
    for (const agentFile of agentFiles) {
      const dst = join(cantAgentsDir, agentFile);
      if (!existsSync(dst)) {
        await copyFile(join(agentsSrc, agentFile), dst);
      }
    }
  }

  // Deploy CLEOOS-IDENTITY.md to global XDG via shared utility.
  // Single SSoT at global path; project path reserved for optional per-project
  // override (loader: cant-context.ts readIdentityFile reads project→global).
  // Same utility is called by `cleo upgrade` so existing projects self-heal.
  try {
    const { ensureGlobalIdentity } = await import('./scaffold.js');
    const identityResult = await ensureGlobalIdentity();
    if (identityResult.action === 'created') {
      created.push(`identity: ${identityResult.path}`);
    } else if (identityResult.action === 'skipped' && identityResult.details) {
      warnings.push(`identity skipped: ${identityResult.details}`);
    }
  } catch (err) {
    warnings.push(`identity deploy failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  created.push(
    'starter-bundle: team + agent .cant files deployed to .cleo/ (identity at global XDG)',
  );
}
