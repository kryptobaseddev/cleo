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

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, symlink, unlink, writeFile } from 'node:fs/promises';
import { platform } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { ExitCode } from '@cleocode/contracts';
import { classifyProject, type ProjectClassification } from './discovery.js';
import { CleoError } from './errors.js';
import { ensureGitHooks } from './hooks.js';
import { ensureInjection } from './injection.js';
import { writeMemoryBridge } from './memory/memory-bridge.js';
import { migrateAgentOutputs } from './migration/agent-outputs.js';
import { getAgentsHome, getCleoDirAbsolute, getProjectRoot } from './paths.js';
// Shared utility imports
import {
  ensureBrainDb,
  ensureCleoGitRepo,
  ensureCleoOsHub,
  ensureCleoStructure,
  ensureConfig,
  ensureGitignore,
  ensureProjectContext,
  ensureProjectInfo,
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
   * Install canonical CleoOS seed agents (cleo-prime, cleo-dev, cleo-historian,
   * cleo-rust-lead, cleo-db-lead, cleoos-opus-orchestrator) into the project's
   * `.cleo/agents/` directory. Default: false (operator opts in).
   *
   * The seeds ship with `@cleocode/agents` under `seed-agents/`. Existing
   * project files are never overwritten — operators are free to delete or
   * fork any seed.
   */
  installSeedAgents?: boolean;
}

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
    const { getInstalledProviders, installSkill, registerSkillLibraryFromPath } = await import(
      '@cleocode/caamp'
    );

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
      if (existsSync(join(skillsPkgRoot, 'skills.json'))) {
        ctSkillsRoot = skillsPkgRoot;
      }
    } catch {
      // Not resolvable via require.resolve — try workspace and node_modules fallbacks
    }

    if (!ctSkillsRoot) {
      try {
        // Workspace monorepo fallback (packages/skills/)
        const bundledPath = join(packageRoot, 'packages', 'skills');
        if (existsSync(join(bundledPath, 'skills.json'))) {
          ctSkillsRoot = bundledPath;
        } else {
          // node_modules fallback
          const ctSkillsPath = join(packageRoot, 'node_modules', '@cleocode', 'skills');
          if (existsSync(join(ctSkillsPath, 'skills.json'))) {
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

    // Read the skills catalog to find core skills
    const catalogPath = join(ctSkillsRoot, 'skills.json');
    const catalog = JSON.parse(readFileSync(catalogPath, 'utf-8'));
    const skills: Array<{
      name: string;
      path: string;
      core: boolean;
      category: string;
      tier: number;
    }> = catalog.skills ?? [];

    // Install core and recommended skills (tier 0, 1, 2)
    const coreSkills = skills.filter((s) => s.tier <= 2);

    const installed: string[] = [];
    for (const skill of coreSkills) {
      const skillSourceDir = dirname(join(ctSkillsRoot, skill.path));

      if (!existsSync(skillSourceDir)) {
        continue;
      }

      try {
        const result = await installSkill(skillSourceDir, skill.name, providers, true);
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
  } catch (err) {
    warnings.push(`Core skill install: ${err instanceof Error ? err.message : String(err)}`);
  }
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
): Promise<void> {
  try {
    const { nexusReconcile } = await import('./nexus/registry.js');
    const result = await nexusReconcile(projectRoot);
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
      await writeFile(prTemplateDest, content, 'utf-8');
      created.push('.github/pull_request_template.md');
    }
  }
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Run update-docs only: refresh all injections without reinitializing.
 * Re-injects CLEO-INJECTION.md into all detected agent instruction files.
 *
 * @task T4686
 */
export async function updateDocs(): Promise<InitResult> {
  const cleoDir = getCleoDirAbsolute();
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
  const cleoDir = getCleoDirAbsolute();
  // `cleo init` CREATES the project root, so we cannot call getProjectRoot()
  // here — that walks up looking for an existing `.cleo/` sentinel and throws
  // `E_NOT_FOUND` when none is present (the whole point of `init` is that
  // none is present yet). `cleoDir` is `<cwd>/.cleo` by default, so its
  // parent directory is the project root. This also respects an absolute
  // `CLEO_DIR` env var used by the init-e2e test suite to pin the target
  // directory.
  const projRoot = dirname(cleoDir);

  // Guard: fail if project already initialized (unless --force)
  const alreadyInitialized =
    existsSync(cleoDir) &&
    (existsSync(join(cleoDir, 'tasks.db')) || existsSync(join(cleoDir, 'config.json')));
  if (alreadyInitialized && !opts.force) {
    throw new CleoError(
      ExitCode.GENERAL_ERROR,
      'Project already initialized. DANGER ZONE: use --force to wipe and re-init.',
      { fix: 'cleo init --force' },
    );
  }

  const force = !!opts.force;

  const created: string[] = [];
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
    const cdResult = ensureConduitDb(projRoot);
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
  const projectInfoResult = await ensureProjectInfo(projRoot, { force });
  if (projectInfoResult.action === 'skipped') {
    skipped.push('project-info.json');
  } else {
    created.push('project-info.json');
  }

  // Project context detection (always run during init)
  try {
    const detectResult = await ensureProjectContext(projRoot, { force: !!opts.detect });
    if (detectResult.action !== 'skipped') {
      created.push('project-context.json');
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
  await initNexusRegistration(projRoot, created, warnings);

  // T5240: Adapter discovery, activation, and install
  try {
    const { AdapterManager } = await import('./adapters/index.js');
    const mgr = AdapterManager.getInstance(projRoot);
    const manifests = mgr.discover();
    if (manifests.length > 0) {
      created.push(`adapters: ${manifests.length} adapter(s) discovered`);
      const detected = mgr.detectActive();
      if (detected.length > 0) {
        created.push(`adapters: active provider detected (${detected.join(', ')})`);

        // Activate and install detected adapters
        for (const adapterId of detected) {
          try {
            const adapter = await mgr.activate(adapterId);
            const installResult = await adapter.install.install({
              projectDir: projRoot,
            });
            if (installResult.success) {
              created.push(`adapter install (${adapterId}): installed`);
            } else {
              warnings.push(`adapter install (${adapterId}): failed`);
            }
          } catch (err) {
            warnings.push(
              `adapter activate/install (${adapterId}): ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }
    }
  } catch (err) {
    warnings.push(`Adapter discovery: ${err instanceof Error ? err.message : String(err)}`);
  }

  // GitHub issue/PR templates (.github/ directory)
  try {
    await installGitHubTemplates(projRoot, created, skipped);
  } catch (err) {
    warnings.push(`GitHub templates: ${err instanceof Error ? err.message : String(err)}`);
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

  // T283: Optional install of canonical CleoOS seed agent personas
  if (opts.installSeedAgents) {
    try {
      const seedDir = await resolveSeedAgentsDir();
      if (seedDir && existsSync(seedDir)) {
        const targetDir = join(projRoot, '.cleo', 'agents');
        await mkdir(targetDir, { recursive: true });
        const seeds = readdirSync(seedDir).filter((f) => f.endsWith('.cant'));
        let installed = 0;
        for (const seed of seeds) {
          const dst = join(targetDir, seed);
          if (!existsSync(dst)) {
            await copyFile(join(seedDir, seed), dst);
            installed++;
          }
        }
        if (installed > 0) {
          created.push(`seed-agents: ${installed} canonical .cant personas installed`);
        }
      } else {
        warnings.push('seed-agents install: bundled seed-agents/ directory not found');
      }
    } catch (err) {
      warnings.push(
        `seed-agents install failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
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
 * Does not overwrite existing files. Resolves the starter bundle from
 * `@cleocode/cleo-os/starter-bundle` or workspace fallback paths.
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

  // Resolve the starter-bundle from @cleocode/cleo-os package
  let starterBundleSrc: string | null = null;
  try {
    const { createRequire } = await import('node:module');
    const req = createRequire(import.meta.url);
    const cleoOsPkgMain = req.resolve('@cleocode/cleo-os/package.json');
    const cleoOsPkgRoot = dirname(cleoOsPkgMain);
    const candidate = join(cleoOsPkgRoot, 'starter-bundle');
    if (existsSync(candidate)) {
      starterBundleSrc = candidate;
    }
  } catch {
    // Not resolvable via require.resolve — try workspace fallbacks
  }

  if (!starterBundleSrc) {
    const packageRoot = getPackageRoot();
    const fallbacks = [
      join(packageRoot, '..', 'cleo-os', 'starter-bundle'),
      join(packageRoot, '..', '..', 'packages', 'cleo-os', 'starter-bundle'),
    ];
    starterBundleSrc = fallbacks.find((p) => existsSync(p)) ?? null;
  }

  if (!starterBundleSrc) {
    warnings.push(
      'Starter bundle not found — .cleo/cant/ will remain empty. Run cleo init in a project with @cleocode/cleo-os installed.',
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

  // Copy CLEOOS-IDENTITY.md to .cleo/ (orchestrator identity for main session agent)
  const identitySrc = join(starterBundleSrc, 'CLEOOS-IDENTITY.md');
  const identityDst = join(cleoDir, 'CLEOOS-IDENTITY.md');
  if (existsSync(identitySrc) && !existsSync(identityDst)) {
    await copyFile(identitySrc, identityDst);
  }

  created.push('starter-bundle: team + agent .cant files + identity deployed to .cleo/');
}
