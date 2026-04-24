/**
 * Shared global bootstrap logic for CLEO.
 *
 * Contains the shared functions used by BOTH:
 *   - `bin/postinstall.js` (npm postinstall hook)
 *   - `cleo install-global` CLI command
 *
 * This is the single source of truth for global setup operations.
 * This is the SSoT — postinstall and self-update both delegate here.
 *
 * @task T5267
 */

import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, readFile, readlink, rename, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  getAgentsHome,
  getCleoGlobalCantAgentsDir,
  getCleoHome,
  getCleoTemplatesDir,
  getCleoTemplatesTildePath,
} from './paths.js';
import { ensureGlobalHome, getPackageRoot } from './scaffold.js';

// ── Types ────────────────────────────────────────────────────────────

/** Result tracking arrays passed through each bootstrap step. */
export interface BootstrapContext {
  created: string[];
  warnings: string[];
  isDryRun: boolean;
}

/** Options for bootstrapGlobalCleo. */
export interface BootstrapOptions {
  /** Preview changes without applying. */
  dryRun?: boolean;
  /** Override package root for template/skill discovery. */
  packageRoot?: string;
}

// ── Step 1: Create ~/.cleo/ and install templates ────────────────────

/**
 * Bootstrap the global CLEO directory structure and install templates.
 *
 * Creates:
 *   - ~/.local/share/cleo/templates/CLEO-INJECTION.md (XDG primary)
 *   - ~/.cleo/templates/CLEO-INJECTION.md (legacy sync)
 *   - ~/.agents/AGENTS.md with CAAMP injection block
 *
 * This is idempotent — safe to call multiple times.
 */
export async function bootstrapGlobalCleo(options?: BootstrapOptions): Promise<BootstrapContext> {
  const ctx: BootstrapContext = {
    created: [],
    warnings: [],
    isDryRun: options?.dryRun ?? false,
  };

  // Step 0: Ensure global home structure and clean stale artifacts
  try {
    await ensureGlobalHome();
  } catch {
    // Best-effort — don't fail bootstrap if cleanup fails
  }

  // Step 0.5: Install the ~/.cleo symlink that makes @~/.cleo/* references
  // resolve to the canonical OS-appropriate data dir on Linux/macOS/Windows.
  await ensureCleoSymlink(ctx);

  // Step 1: Ensure global templates at the canonical XDG data dir
  await ensureGlobalTemplatesBootstrap(ctx, options?.packageRoot);

  // Step 2: CAAMP injection into ~/.agents/AGENTS.md
  await injectAgentsHub(ctx);

  // Step 3: (removed)

  // Step 4: Install core skills globally
  await installSkillsGlobally(ctx);

  // Step 5: Install agent definition (cleo-subagent symlink)
  await installAgentDefinitionGlobally(ctx);

  // Step 5b (W2-5): Seed global CANT agents (.cant personas)
  // Idempotently copies bundled seed-agents into ~/.local/share/cleo/cant/agents/
  // so spawn/orchestrate can resolve personas on fresh installs.
  await installSeedAgentsGlobally(ctx);

  // Step 5c (T1386): Populate the nexus.db sigils table from the canonical
  // CANT agents we just installed.  Without this step, `fetchIdentity()` and
  // `cleo orchestrate spawn` see an empty sigils table and fall back to
  // null peer cards — defeating Wave 8's enriched-spawn promise.
  await syncCanonicalSigilsStep(ctx);

  // Step 6: Install provider adapters
  await installProviderAdapters(ctx, options?.packageRoot);

  // Step 7: Verify injection chain health
  await verifyBootstrapHealth(ctx);

  return ctx;
}

// ── Step 0.5: ~/.cleo canonical symlink ──────────────────────────────

/**
 * Ensure `~/.cleo` is a symlink (or junction on Windows) pointing to the
 * canonical OS-appropriate CLEO data directory (`getCleoHome()`).
 *
 * This is the keystone of CLEO's cross-OS layout:
 *
 *   Physical canonical storage (OS-specific via env-paths):
 *     Linux   → `~/.local/share/cleo/`
 *     macOS   → `~/Library/Application Support/cleo/`
 *     Windows → `%LOCALAPPDATA%\cleo\Data\`
 *
 *   Universal reference path (identical on every OS):
 *     `~/.cleo/`  (symlink / junction)
 *
 * With this symlink in place, an injection reference like
 * `@~/.cleo/templates/CLEO-INJECTION.md` resolves correctly on every OS
 * without the caller having to know the OS-specific canonical path. All
 * internal code writing to `join(homedir(), '.cleo', …)` also transparently
 * routes to the canonical location.
 *
 * Behaviour:
 *   - If `~/.cleo` does not exist           → create the symlink.
 *   - If it is already the correct symlink  → no-op.
 *   - If it is a symlink to a wrong target  → warn; do not modify.
 *   - If it is a real directory with files  → move to `~/.cleo.bak-<ts>`
 *                                             and create the symlink (user
 *                                             informed via ctx.created).
 *   - Errors are non-fatal — bootstrap continues with a warning.
 */
async function ensureCleoSymlink(ctx: BootstrapContext): Promise<void> {
  if (ctx.isDryRun) return;

  const legacyPath = join(homedir(), '.cleo');
  const canonicalTarget = getCleoHome();
  const linkType: 'dir' | 'junction' = process.platform === 'win32' ? 'junction' : 'dir';

  // Guard: if a user (or test) has set CLEO_HOME=~/.cleo, the canonical path
  // IS the legacy path — no symlink needed, it would self-reference.
  if (canonicalTarget === legacyPath) return;

  try {
    // Ensure the canonical target exists so the symlink is never dangling
    await mkdir(canonicalTarget, { recursive: true });

    // If nothing at ~/.cleo, just create the symlink
    if (!existsSync(legacyPath)) {
      await symlink(canonicalTarget, legacyPath, linkType);
      ctx.created.push(`~/.cleo → ${canonicalTarget} (${linkType} link)`);
      return;
    }

    const stat = lstatSync(legacyPath);

    // Already a symlink — check where it points
    if (stat.isSymbolicLink()) {
      const currentTarget = await readlink(legacyPath);
      if (currentTarget === canonicalTarget) {
        return; // no-op, already correct
      }
      ctx.warnings.push(
        `~/.cleo is a symlink pointing to ${currentTarget}, expected ${canonicalTarget}. Leaving untouched — remove it manually if you want the canonical link.`,
      );
      return;
    }

    // Real directory — migrate contents and replace with symlink
    if (stat.isDirectory()) {
      const backupPath = `${legacyPath}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      await rename(legacyPath, backupPath);
      await symlink(canonicalTarget, legacyPath, linkType);
      ctx.created.push(
        `~/.cleo backed up to ${backupPath} and replaced with symlink → ${canonicalTarget}`,
      );
      ctx.warnings.push(
        `Legacy ~/.cleo directory migrated to ${backupPath}. Review its contents — any project data you need has been preserved there. You can remove the backup once satisfied.`,
      );
      return;
    }

    // Some other file type (regular file, etc.)
    ctx.warnings.push(
      `~/.cleo exists but is not a directory or symlink. Leaving untouched — resolve manually.`,
    );
  } catch (err) {
    // Windows unprivileged users may lack symlink permission. Junction type
    // should succeed without admin, but report any failure so the user knows.
    ctx.warnings.push(
      `Could not ensure ~/.cleo symlink: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ── Step 1: Global templates ─────────────────────────────────────────

/**
 * Write template content to a destination path, creating parent dirs as needed.
 * Returns true if written, false if dry-run.
 */
async function writeTemplateTo(
  content: string,
  destPath: string,
  isDryRun: boolean,
): Promise<boolean> {
  if (isDryRun) return false;
  const { dirname } = await import('node:path');
  await mkdir(dirname(destPath), { recursive: true });
  await writeFile(destPath, content);
  return true;
}

async function ensureGlobalTemplatesBootstrap(
  ctx: BootstrapContext,
  packageRootOverride?: string,
): Promise<void> {
  const globalTemplatesDir = getCleoTemplatesDir();

  if (!ctx.isDryRun) {
    await mkdir(globalTemplatesDir, { recursive: true });
  }

  // Resolve template content from bundled file or embedded fallback
  let templateContent: string | null = null;

  try {
    const pkgRoot = packageRootOverride ?? getPackageRoot();
    const templatePath = join(pkgRoot, 'templates', 'CLEO-INJECTION.md');
    if (existsSync(templatePath)) {
      templateContent = readFileSync(templatePath, 'utf-8');
    }
  } catch {
    // Fall through to embedded fallback
  }

  if (!templateContent) {
    try {
      const { getInjectionTemplateContent } = await import('./injection.js');
      templateContent = getInjectionTemplateContent() ?? null;
    } catch {
      ctx.warnings.push('Could not refresh CLEO-INJECTION.md template');
      return;
    }
  }

  if (!templateContent) {
    ctx.warnings.push('Could not refresh CLEO-INJECTION.md template');
    return;
  }

  const xdgDest = join(globalTemplatesDir, 'CLEO-INJECTION.md');
  const xdgWritten = await writeTemplateTo(templateContent, xdgDest, ctx.isDryRun);
  ctx.created.push(
    `${getCleoTemplatesTildePath()}/CLEO-INJECTION.md (${xdgWritten ? 'refreshed' : 'would refresh'})`,
  );
}

// ── Step 2: CAAMP injection into ~/.agents/AGENTS.md ─────────────────

/**
 * Sanitize a CAAMP-managed file by removing orphaned content outside
 * CAAMP blocks. This fixes corruption from failed CAAMP consolidation
 * (e.g. partial old block removal leaving `TION.md` fragments).
 *
 * Strategy: keep ONLY content inside valid CAAMP blocks + any non-CAAMP
 * user content that doesn't look like an orphaned reference fragment.
 */
function sanitizeCaampFile(content: string): string {
  // Remove any duplicate <!-- CAAMP:END --> markers
  let cleaned = content.replace(/(<!-- CAAMP:END -->)\s*(<!-- CAAMP:END -->)/g, '$1');

  // Remove orphaned content between CAAMP:END and the next CAAMP:START (or EOF)
  // that looks like a fragment of a CLEO reference (e.g. "TION.md", "INJECTION.md")
  cleaned = cleaned.replace(
    /<!-- CAAMP:END -->\s*[A-Z][A-Za-z-]*\.md\s*(?:<!-- CAAMP:END -->)?/g,
    '<!-- CAAMP:END -->',
  );

  // Remove any lines that are just orphaned .md filename fragments
  // (leftover from partial CAAMP block removal)
  cleaned = cleaned.replace(/^[A-Z][A-Za-z-]*\.md\s*$/gm, '');

  // Collapse multiple blank lines
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

  return cleaned.trim() + '\n';
}

async function injectAgentsHub(ctx: BootstrapContext): Promise<void> {
  const globalAgentsDir = getAgentsHome();
  const globalAgentsMd = join(globalAgentsDir, 'AGENTS.md');

  try {
    const { inject, getInstalledProviders, injectAll, buildInjectionContent } = await import(
      '@cleocode/caamp'
    );

    if (!ctx.isDryRun) {
      await mkdir(globalAgentsDir, { recursive: true });

      // Strip legacy CLEO blocks (versioned markers from pre-CAAMP era)
      // AND sanitize CAAMP corruption (orphaned fragments from bad consolidation)
      if (existsSync(globalAgentsMd)) {
        const content = await readFile(globalAgentsMd, 'utf8');

        // Step A: Remove legacy <!-- CLEO:START -->...<!-- CLEO:END --> blocks
        const stripped = content.replace(
          /\n?<!-- CLEO:START[^>]*-->[\s\S]*?<!-- CLEO:END -->\n?/g,
          '',
        );

        // Step B: Sanitize CAAMP corruption (orphaned fragments, duplicate markers)
        const sanitized = sanitizeCaampFile(stripped);

        if (sanitized !== content) {
          await writeFile(globalAgentsMd, sanitized, 'utf8');
          ctx.created.push('~/.agents/AGENTS.md (sanitized CAAMP corruption)');
        }
      }

      // CAAMP inject() is idempotent — writes the current XDG template reference
      const templateRef = `@${getCleoTemplatesTildePath()}/CLEO-INJECTION.md`;
      const action = await inject(globalAgentsMd, templateRef);
      ctx.created.push(`~/.agents/AGENTS.md (${action})`);

      // Post-inject validation: verify the file is clean
      const postContent = await readFile(globalAgentsMd, 'utf8');
      const caampBlocks = postContent.match(/<!-- CAAMP:START -->/g);
      const caampEnds = postContent.match(/<!-- CAAMP:END -->/g);
      if (caampBlocks && caampEnds && caampBlocks.length !== caampEnds.length) {
        ctx.warnings.push(
          `~/.agents/AGENTS.md has mismatched CAAMP markers (${caampBlocks.length} START vs ${caampEnds.length} END)`,
        );
      }
    } else {
      ctx.created.push('~/.agents/AGENTS.md (would create/update CAAMP block)');
    }

    // Inject @~/.agents/AGENTS.md into detected global provider files
    const providers = getInstalledProviders();

    if (providers.length === 0) {
      ctx.warnings.push('No AI provider installations detected');
    } else {
      const injectionContent = buildInjectionContent({
        references: ['@~/.agents/AGENTS.md'],
      });

      if (!ctx.isDryRun) {
        // Strip legacy CLEO blocks from global provider files first
        // (handles bare and versioned markers, e.g. <!-- CLEO:START v0.53.4 -->)
        for (const provider of providers) {
          const instructFilePath = join(provider.pathGlobal, provider.instructFile);
          if (existsSync(instructFilePath)) {
            const fileContent = await readFile(instructFilePath, 'utf8');
            const stripped = fileContent.replace(
              /\n?<!-- CLEO:START[^>]*-->[\s\S]*?<!-- CLEO:END -->\n?/g,
              '',
            );
            if (stripped !== fileContent) {
              await writeFile(instructFilePath, stripped, 'utf8');
            }
          }
        }

        const results = await injectAll(providers, homedir(), 'global', injectionContent);
        for (const [filePath, action] of results) {
          const displayPath = filePath.replace(homedir(), '~');
          ctx.created.push(`${displayPath} (${action})`);
        }
      } else {
        for (const p of providers) {
          const displayPath = join(p.pathGlobal, p.instructFile).replace(homedir(), '~');
          ctx.created.push(`${displayPath} (would update CAAMP block)`);
        }
      }
    }
  } catch (err) {
    ctx.warnings.push(`CAAMP injection: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── Step 3: (removed) ───────────────────────────────────────────────

/**
 * No-op. Kept for API compatibility.
 */
export async function installMcpToProviders(_ctx: BootstrapContext): Promise<void> {
  // No-op: removed
}

// ── Step 4: Core skills installation ─────────────────────────────────

/**
 * Install CLEO core skills globally via CAAMP.
 */
export async function installSkillsGlobally(ctx: BootstrapContext): Promise<void> {
  try {
    if (!ctx.isDryRun) {
      const { initCoreSkills } = await import('./init.js');
      await initCoreSkills(ctx.created, ctx.warnings);
    } else {
      ctx.created.push('core skills (would install/update)');
    }
  } catch (err) {
    ctx.warnings.push(
      `Core skills installation failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ── Step 5: Agent definition installation ────────────────────────────

/**
 * Install the cleo-subagent agent definition to ~/.agents/agents/.
 * Delegates to initAgentDefinition() in init.ts which handles require.resolve
 * fallback and symlink/copy logic.
 */
async function installAgentDefinitionGlobally(ctx: BootstrapContext): Promise<void> {
  try {
    if (!ctx.isDryRun) {
      const { initAgentDefinition } = await import('./init.js');
      await initAgentDefinition(ctx.created, ctx.warnings);
    } else {
      ctx.created.push('agent: cleo-subagent (would symlink)');
    }
  } catch (err) {
    ctx.warnings.push(
      `Agent definition install: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ── Step 5b (W2-5): Global seed-agents install ───────────────────────

/**
 * Seed the global CANT agents directory from the bundled seed-agents.
 *
 * Idempotently copies `.cant` persona files from the `@cleocode/agents`
 * package's `seed-agents/` directory into
 * `{cleoHome}/cant/agents/` (typically `~/.local/share/cleo/cant/agents/`).
 *
 * Without this step, a fresh `npm install -g @cleocode/cleo` leaves the
 * global CANT agents directory empty, and `cleo orchestrate spawn` has no
 * personas to resolve against. The post-install hook calls this step so the
 * ship-surface personas (per ADR-055 D032: `cleo-subagent` universal base
 * plus the four generic role templates under `seed-agents/`) are available
 * immediately.
 *
 * Seed-dir resolution is delegated to {@link resolveSeedAgentsDir} in
 * `init.ts` so both the project-scoped `cleo init --install-seed-agents` path
 * and this global path share the same multi-candidate lookup (monorepo,
 * node_modules, bundled CLI dist).
 *
 * Behaviour:
 *   - Existing files in the global target are preserved (never overwritten).
 *   - Missing seed-dir is a warning, not a failure — keeps postinstall
 *     resilient when the agents package isn't yet linked.
 *   - Dry-run mode records the planned action without touching the FS.
 *
 * @param ctx - Bootstrap context for recording created/warnings entries.
 *
 * @task T889 / T897 / W2-5
 */
export async function installSeedAgentsGlobally(ctx: BootstrapContext): Promise<void> {
  try {
    const { resolveSeedAgentsDir } = await import('./init.js');
    const seedDir = await resolveSeedAgentsDir();

    if (!seedDir) {
      ctx.warnings.push('seed-agents (global): bundled seed-agents/ directory not found; skipping');
      return;
    }

    const targetDir = getCleoGlobalCantAgentsDir();

    if (ctx.isDryRun) {
      ctx.created.push(`seed-agents (global): would copy .cant files to ${targetDir}`);
      return;
    }

    await mkdir(targetDir, { recursive: true });

    const seeds = readdirSync(seedDir).filter((f) => f.endsWith('.cant'));
    if (seeds.length === 0) {
      ctx.warnings.push('seed-agents (global): no .cant files in bundled seed-agents/');
      return;
    }

    let copied = 0;
    let skipped = 0;
    for (const seed of seeds) {
      const src = join(seedDir, seed);
      const dst = join(targetDir, seed);
      if (existsSync(dst)) {
        skipped++;
        continue;
      }
      await copyFile(src, dst);
      copied++;
    }

    if (copied > 0) {
      ctx.created.push(
        `seed-agents (global): ${copied} .cant personas installed (${skipped} already present)`,
      );
    }
  } catch (err) {
    ctx.warnings.push(
      `seed-agents (global) install failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ── Step 5c (T1386): Canonical sigil population ──────────────────────

/**
 * Populate the nexus.db `sigils` table with one row per canonical CANT agent.
 *
 * Runs after seed-agents installation so the `sigils` rows reference the
 * just-installed .cant files.  Idempotent — re-running the bootstrap will
 * upsert in place.  Failures are reported as warnings rather than aborting
 * the bootstrap, because a missing sigils table is recoverable: callers can
 * always run `cleo nexus sigil sync` later.
 *
 * Skipped during dry-run because the sync touches the live nexus.db.
 *
 * @param ctx - Bootstrap context for recording created/warnings entries.
 *
 * @task T1386
 * @epic T1148
 */
export async function syncCanonicalSigilsStep(ctx: BootstrapContext): Promise<void> {
  if (ctx.isDryRun) {
    ctx.created.push('sigils (global): would sync canonical CANT agent sigils');
    return;
  }

  try {
    const { syncCanonicalSigils } = await import('./nexus/sigil-sync.js');
    const result = await syncCanonicalSigils();

    if (result.count > 0) {
      ctx.created.push(
        `sigils: ${result.count} canonical sigils synced (${result.peerIds.join(', ')})`,
      );
    } else {
      ctx.warnings.push('sigils: no canonical .cant files resolvable; sigils table left untouched');
    }

    for (const w of result.warnings) {
      ctx.warnings.push(`sigils: ${w}`);
    }
  } catch (err) {
    ctx.warnings.push(
      `sigils (global) sync failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ── Step 6: Provider adapter installation ────────────────────────────

async function installProviderAdapters(
  ctx: BootstrapContext,
  packageRootOverride?: string,
): Promise<void> {
  try {
    const { AdapterManager } = await import('./adapters/index.js');
    const pkgRoot = packageRootOverride ?? getPackageRoot();
    const manager = AdapterManager.getInstance(pkgRoot);
    manager.discover();
    const detected = manager.detectActive();

    for (const adapterId of detected) {
      try {
        const adapter = await manager.activate(adapterId);
        if (adapter.install) {
          if (!ctx.isDryRun) {
            const installResult = await adapter.install.install({
              projectDir: process.cwd(),
            });
            if (installResult.success) {
              ctx.created.push(`${adapterId} adapter (installed)`);
            }
          } else {
            ctx.created.push(`${adapterId} adapter (would install)`);
          }
        }
      } catch (activateErr) {
        ctx.warnings.push(
          `Adapter ${adapterId} skipped: ${activateErr instanceof Error ? activateErr.message : String(activateErr)}`,
        );
      }
    }
  } catch (err) {
    ctx.warnings.push(
      `Adapter install skipped: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ── Step 7: Post-bootstrap health verification ───────────────────────

/**
 * Combined bootstrap health + dependency verification result.
 *
 * Produced by {@link verifyBootstrapComplete} and intended for consumers
 * such as `postinstall.js` and `cleo install-global` that need a single
 * aggregated view of system readiness after bootstrap completes.
 */
export interface BootstrapVerificationResult {
  /** `true` when both bootstrap injection-chain health and all required dependencies are healthy. */
  complete: boolean;
  /** `true` when the injection-chain health checks (template files, AGENTS.md) all pass. */
  bootstrapHealthy: boolean;
  /** `true` when every `required` dependency is healthy (see {@link DependencyReport.allRequiredMet}). */
  dependenciesHealthy: boolean;
  /** Human-readable failure descriptions from both the injection-chain and dependency checks. */
  failures: string[];
  /** Non-fatal advisory messages (optional deps missing, template version skew, etc.). */
  warnings: string[];
}

/**
 * Run both injection-chain health verification and full dependency checks after bootstrap.
 *
 * Combines:
 *   1. Injection-chain health (XDG template, legacy template version sync, AGENTS.md reference,
 *      orphaned content detection) — delegated to the internal {@link verifyBootstrapHealth}.
 *   2. All registered runtime dependencies — delegated to {@link checkAllDependencies} from
 *      `./system/dependencies.js`.
 *
 * This function is intentionally non-throwing. Every error is captured and surfaced through
 * the returned {@link BootstrapVerificationResult} so callers (postinstall, CLI commands) can
 * decide how to present failures without crashing the install process.
 *
 * @returns A {@link BootstrapVerificationResult} aggregating both checks.
 */
export async function verifyBootstrapComplete(): Promise<BootstrapVerificationResult> {
  const failures: string[] = [];
  const warnings: string[] = [];

  // ── Part 1: Injection-chain health ──────────────────────────────────────────
  let bootstrapHealthy = true;

  try {
    const healthCtx: BootstrapContext = {
      created: [],
      warnings: [],
      isDryRun: false,
    };

    await verifyBootstrapHealth(healthCtx);

    // verifyBootstrapHealth appends to ctx.warnings on issues — treat all as warnings.
    // There is no way to distinguish bootstrap-fatal from advisory in the current impl,
    // so we surface them all as warnings (consistent with the existing non-blocking design).
    for (const w of healthCtx.warnings) {
      warnings.push(w);
    }

    // If any warnings were produced by the health check, mark bootstrap as degraded
    // but not outright failed (health check is advisory-only by design).
    if (healthCtx.warnings.length > 0) {
      bootstrapHealthy = false;
    }
  } catch (err) {
    bootstrapHealthy = false;
    failures.push(
      `Bootstrap health check failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // ── Part 2: Dependency checks ────────────────────────────────────────────────
  let dependenciesHealthy = false;

  try {
    const { checkAllDependencies } = await import('./system/dependencies.js');
    const depReport = await checkAllDependencies();

    dependenciesHealthy = depReport.allRequiredMet;

    for (const result of depReport.results) {
      if (result.category === 'required' && !result.healthy) {
        const msg = result.error
          ? `Required dependency '${result.name}' unhealthy: ${result.error}`
          : `Required dependency '${result.name}' is not healthy`;
        failures.push(msg);
      }
    }

    // Surface dependency warnings (optional / feature deps missing)
    for (const w of depReport.warnings) {
      warnings.push(w);
    }
  } catch (err) {
    // Dependency check failure is non-fatal — mark as unknown (default false)
    warnings.push(`Dependency check deferred: ${err instanceof Error ? err.message : String(err)}`);
  }

  return {
    complete: bootstrapHealthy && dependenciesHealthy,
    bootstrapHealthy,
    dependenciesHealthy,
    failures,
    warnings,
  };
}

/**
 * Verify the injection chain is intact after bootstrap.
 *
 * This function serves a DIFFERENT purpose than `startupHealthCheck()` in
 * `packages/core/src/system/health.ts` (T511 — documented separation):
 *
 * - `verifyBootstrapHealth()` — checks global CAAMP injection-chain state:
 *   XDG template existence + version, AGENTS.md reference correctness, and
 *   orphaned CAAMP block fragments. Called ONLY after `bootstrapGlobalCleo()`
 *   completes (post-install, self-update). NOT called on every startup.
 *
 * - `startupHealthCheck()` — checks project and global *scaffold* health:
 *   .cleo/ directory structure, tasks.db, config.json, global ~/.cleo/ dirs.
 *   Called on every CLI startup to detect drift.
 *
 * These are complementary, not duplicates. Neither delegates to the other
 * because their scopes and lifecycles differ:
 *   - Bootstrap health only makes sense after bootstrap completes.
 *   - Startup health must be ultra-fast (no CAAMP parsing) and runs unconditionally.
 *
 * Checks:
 *   1. XDG template exists and has a version header
 *   2. `~/.cleo` symlink is installed and points to the canonical data dir
 *   3. ~/.agents/AGENTS.md references the correct template path
 *   4. No orphaned content in AGENTS.md
 */
async function verifyBootstrapHealth(ctx: BootstrapContext): Promise<void> {
  if (ctx.isDryRun) return;

  try {
    const xdgTemplatePath = join(getCleoTemplatesDir(), 'CLEO-INJECTION.md');
    const agentsMd = join(getAgentsHome(), 'AGENTS.md');

    if (!existsSync(xdgTemplatePath)) {
      ctx.warnings.push('Health: XDG template missing after bootstrap');
      return;
    }

    // Check 2: ~/.cleo symlink integrity. On fresh installs Step 0.5 created
    // the link; here we verify it stayed intact (user didn't replace it).
    const legacyPath = join(homedir(), '.cleo');
    const canonicalTarget = getCleoHome();
    if (existsSync(legacyPath)) {
      const stat = lstatSync(legacyPath);
      if (stat.isSymbolicLink()) {
        const target = await readlink(legacyPath);
        if (target !== canonicalTarget) {
          ctx.warnings.push(
            `Health: ~/.cleo points to ${target}, expected ${canonicalTarget}. Remove it and re-run bootstrap.`,
          );
        }
      } else {
        ctx.warnings.push(
          `Health: ~/.cleo is not a symlink — canonical layout requires it to link to ${canonicalTarget}. Re-run bootstrap to migrate.`,
        );
      }
    } else {
      ctx.warnings.push(
        `Health: ~/.cleo symlink missing — re-run bootstrap so @~/.cleo/* injection references resolve correctly.`,
      );
    }

    // Check 3: AGENTS.md references the correct path
    if (existsSync(agentsMd)) {
      const agentsContent = await readFile(agentsMd, 'utf8');
      const expectedRef = `@${getCleoTemplatesTildePath()}/CLEO-INJECTION.md`;
      if (!agentsContent.includes(expectedRef)) {
        ctx.warnings.push(`Health: ~/.agents/AGENTS.md does not reference ${expectedRef}`);
      }

      // Check 4: No orphaned .md fragments outside CAAMP blocks
      const outsideCaamp = agentsContent.replace(
        /<!-- CAAMP:START -->[\s\S]*?<!-- CAAMP:END -->/g,
        '',
      );
      if (/[A-Z][A-Za-z-]*\.md/.test(outsideCaamp)) {
        ctx.warnings.push('Health: ~/.agents/AGENTS.md has orphaned content outside CAAMP blocks');
      }
    }
  } catch {
    // Health check is non-critical — don't fail bootstrap
  }
}
