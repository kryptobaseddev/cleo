/**
 * CAAMP injection management — manages agent instruction file injection.
 *
 * Extracted from init.ts to enable shared use across init, upgrade, and doctor.
 *
 * Handles:
 *   1. Injecting @AGENTS.md into provider instruction files (CLAUDE.md, GEMINI.md, etc.)
 *   2. Injecting CLEO protocol content into AGENTS.md itself
 *   3. Installing CLEO-INJECTION.md to global templates directory
 *   4. Creating global ~/.agents/AGENTS.md hub
 *   5. Stripping legacy CLEO blocks and removing deprecated files
 *   6. Checking injection health (CAAMP markers, @ reference resolution)
 *
 * @task T4682
 */

import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, delimiter, join } from 'node:path';
import type { Provider } from '@cleocode/caamp';
import { getAgentsHome, getCanonicalTemplatesTildePath, getCleoHome } from './paths.js';
import { getPackageRoot, stripCLEOBlocks } from './scaffold.js';
import { resolveBridgeMode } from './system/bridge-mode.js';

// ── Types ────────────────────────────────────────────────────────────
//
// ScaffoldResult is now sourced from `@cleocode/contracts/scaffold-diagnostics`
// (SG-ARCH-SOLID T9831 · E-CONTRACTS-FOUNDATION T9832 Phase 0a). Re-exported
// here to preserve the public surface of `@cleocode/core/injection`.
//
// InjectionCheckResult remains a locally-scoped distinct type — it is
// structurally identical to CheckResult, but the `cleo doctor` consumer
// addresses it by its narrower name. Consolidation with CheckResult is
// deferred to a follow-up cleanup task.

import {
  CAAMP_DAMAGED_END_PATTERN_SOURCE,
  CAAMP_DAMAGED_START_PATTERN_SOURCE,
  type GlobalInstructionRefreshReport,
  type GlobalInstructionStalenessReport,
} from '@cleocode/contracts/caamp-markers';
import type { ScaffoldResult } from '@cleocode/contracts/scaffold-diagnostics';

export type { ScaffoldResult } from '@cleocode/contracts/scaffold-diagnostics';

/** Structural alias of {@link CheckResult} used by injection health checks. */
export interface InjectionCheckResult {
  id: string;
  category: string;
  status: 'passed' | 'failed' | 'warning' | 'info';
  message: string;
  details: Record<string, unknown>;
  fix: string | null;
}

// ── Template content ─────────────────────────────────────────────────

/**
 * Get the CLEO-INJECTION.md template content from the package templates/ directory.
 * Returns null if the template file is not found.
 */
export function getInjectionTemplateContent(): string | null {
  const packageRoot = getPackageRoot();
  const packageTemplatePath = join(packageRoot, 'templates', 'CLEO-INJECTION.md');
  if (existsSync(packageTemplatePath)) {
    return readFileSync(packageTemplatePath, 'utf-8');
  }
  return null;
}

// ── Legacy cleanup ───────────────────────────────────────────────────

/**
 * Remove deprecated .cleo/templates/AGENT-INJECTION.md if it exists.
 * This file was replaced by the global ~/.cleo/templates/CLEO-INJECTION.md
 * pattern in v0.75.0. Auto-cleaned during init and upgrade.
 */
async function removeStaleAgentInjection(projectRoot: string): Promise<boolean> {
  const stalePath = join(projectRoot, '.cleo', 'templates', 'AGENT-INJECTION.md');
  if (!existsSync(stalePath)) return false;
  await rm(stalePath, { force: true });
  return true;
}

/**
 * Strip hardcoded `<!-- gitnexus:start -->...<!-- gitnexus:end -->` blocks
 * from AGENTS.md. These blocks are replaced by the `@.cleo/nexus-bridge.md`
 * reference which contains auto-generated code intelligence content (T552).
 *
 * Also strips any other known vendor marker blocks using the same pattern
 * (e.g. `<!-- gitnexus:start -->...<!-- gitnexus:end -->`).
 *
 * @param filePath - Absolute path to the file to strip
 * @returns True if the file was modified, false otherwise
 */
export async function stripGitNexusBlocks(filePath: string): Promise<boolean> {
  if (!existsSync(filePath)) return false;
  const content = await readFile(filePath, 'utf8');
  // Strip <!-- gitnexus:start --> ... <!-- gitnexus:end --> blocks (case-insensitive markers)
  const stripped = content.replace(
    /\n?<!--\s*gitnexus:start\s*-->[\s\S]*?<!--\s*gitnexus:end\s*-->\n?/gi,
    '',
  );
  if (stripped !== content) {
    await writeFile(filePath, stripped, 'utf8');
    return true;
  }
  return false;
}

// ── Ensure injection ─────────────────────────────────────────────────

/**
 * Full injection refresh: strip legacy blocks, inject CAAMP content,
 * install global template, create hub.
 *
 * Replaces initInjection from init.ts with a ScaffoldResult return type.
 *
 * Target architecture:
 *   CLAUDE.md/GEMINI.md -> @AGENTS.md (via injectAll)
 *   AGENTS.md -> @~/.agents/AGENTS.md + @.cleo/project-context.json + @.cleo/memory-bridge.md + @.cleo/nexus-bridge.md
 *
 * @task T4682
 */
export async function ensureInjection(projectRoot: string): Promise<ScaffoldResult> {
  // Dynamic import — @cleocode/caamp may not be installed
  let caamp: typeof import('@cleocode/caamp');
  try {
    caamp = await import('@cleocode/caamp');
  } catch {
    return {
      action: 'skipped',
      path: join(projectRoot, 'AGENTS.md'),
      details: '@cleocode/caamp not installed, skipping injection',
    };
  }

  const { getInstalledProviders, inject, injectAll, resolveInstructionDelivery } = caamp;

  const providers = getInstalledProviders();
  const actions: string[] = [];

  if (providers.length === 0) {
    actions.push('No providers detected (AGENTS.md created without provider injection)');
  } else {
    // Step 0: Strip legacy CLEO blocks and remove deprecated AGENT-INJECTION.md
    for (const provider of providers) {
      const instructFile = join(projectRoot, provider.pathProject, provider.instructFile);
      await stripCLEOBlocks(instructFile);
    }
    await stripCLEOBlocks(join(projectRoot, 'AGENTS.md'));
    const removedStale = await removeStaleAgentInjection(projectRoot);
    if (removedStale) {
      actions.push('removed deprecated AGENT-INJECTION.md');
    }

    // Step 0b: Strip hardcoded gitnexus blocks from AGENTS.md (T552)
    // These are replaced by the @.cleo/nexus-bridge.md reference.
    const removedGitNexus = await stripGitNexusBlocks(join(projectRoot, 'AGENTS.md'));
    if (removedGitNexus) {
      actions.push('removed hardcoded gitnexus block from AGENTS.md');
    }
  }

  // Step 2: Inject CLEO protocol content into AGENTS.md itself
  // Project AGENTS.md references the global hub, which loads CLEO-INJECTION.md
  const agentsMdPath = join(projectRoot, 'AGENTS.md');
  const agentsMdLines = ['@~/.agents/AGENTS.md'];

  const projectContextPath = join(projectRoot, '.cleo', 'project-context.json');
  if (existsSync(projectContextPath)) {
    agentsMdLines.push('@.cleo/project-context.json');
  }

  // Memory bridge + nexus bridge: gated by brain.memoryBridge.mode (T999 · T9425)
  // mode='cli' (default): inject a CLI directive so agents query brain.db live
  // mode='file': legacy @-inject of auto-generated markdown files (backcompat)
  // mode='disabled': suppress BRAIN-driven AGENTS.md augmentation entirely
  const bridgeMode = await resolveBridgeMode(projectRoot);
  if (bridgeMode === 'file') {
    const memoryBridgePath = join(projectRoot, '.cleo', 'memory-bridge.md');
    if (existsSync(memoryBridgePath)) {
      agentsMdLines.push('@.cleo/memory-bridge.md');
    }

    const nexusBridgePath = join(projectRoot, '.cleo', 'nexus-bridge.md');
    if (existsSync(nexusBridgePath)) {
      agentsMdLines.push('@.cleo/nexus-bridge.md');
    }
  } else if (bridgeMode === 'cli') {
    // cli mode: inject a directive instructing agents to query live context.
    //
    // gh#1373: the directive used to read `cleo memory digest --brief`.
    // `digest` declares no `--brief` — its flags are `--hygiene`, `--limit`,
    // `--json` — and citty parses non-strictly, so the flag was absorbed and
    // discarded. The command still produced a digest because a digest is what
    // it does by default, which is precisely why nothing ever reported it:
    // this line wrote a nonexistent flag into the AGENTS.md of every project
    // using cli bridge mode, and the output looked correct every time.
    agentsMdLines.push('# Run: cleo memory digest');
  }
  // 'disabled' mode: no bridge injection at all (T9425).

  // Contributor project warning (ADR-029): inject dev-channel guidance when
  // this project IS the CLEO source repo, so agents use cleo-dev not @latest.
  const contributorBlock = buildContributorInjectionBlock(projectRoot);
  if (contributorBlock) {
    agentsMdLines.push(contributorBlock);
  }

  const agentsMdContent = agentsMdLines.join('\n');

  // Step 3: Install CLEO-INJECTION.md to global templates dir
  const content = getInjectionTemplateContent();
  if (content) {
    const globalTemplatesDir = join(getCleoHome(), 'templates');
    await mkdir(globalTemplatesDir, { recursive: true });
    const globalPath = join(globalTemplatesDir, 'CLEO-INJECTION.md');
    if (!existsSync(globalPath) || (await readFile(globalPath, 'utf8')) !== content) {
      // Package-owned template: refresh stale installed versions before resolving bootstrap.
      // T10368-audit-ok: injection.global-cleo-injection
      await writeFile(globalPath, content);
      actions.push('refreshed global CLEO-INJECTION.md');
    }
  }

  // Step 4: Create global ~/.agents/AGENTS.md hub (idempotent)
  try {
    const globalAgentsDir = getAgentsHome();
    const globalAgentsMd = join(globalAgentsDir, 'AGENTS.md');
    // Use the canonical symlink path (@~/.cleo/templates) rather than the
    // CLEO_HOME-derived path. CLEO_HOME may be a temp directory in test
    // environments, which would write a stale temp-path block into the real
    // ~/.agents/AGENTS.md on every test run (T9020 / T1929).
    const globalHubContent = `@${getCanonicalTemplatesTildePath()}/CLEO-INJECTION.md`;
    await mkdir(globalAgentsDir, { recursive: true });
    // Direct call — CAAMP 1.8.0 handles idempotency
    await inject(globalAgentsMd, globalHubContent);
  } catch {
    // Best-effort — don't fail if global hub creation fails
  }

  // Resolve before writing project/provider files. Provider reference expansion is
  // not guaranteed; failed resolution must not replace a previously usable block.
  const delivery = await resolveInstructionDelivery(agentsMdContent, projectRoot);
  const failures = delivery.findings.filter((finding) => finding.kind !== 'duplicate');
  if (failures.length > 0) {
    return {
      action: 'skipped',
      path: agentsMdPath,
      details: `Instruction delivery failed: ${failures.map((finding) => `${finding.kind}: ${finding.path}`).join('; ')}`,
    };
  }
  const agentsAction = await inject(agentsMdPath, delivery.content);
  actions.push(`AGENTS.md self-contained CLEO content (${agentsAction})`);
  // Other native instruction files embed the complete project rules as well.
  const projectInstructions = await readFile(agentsMdPath, 'utf8');
  const providerDelivery = await resolveInstructionDelivery(projectInstructions, projectRoot);
  const providerFailures = providerDelivery.findings.filter(
    (finding) => finding.kind !== 'duplicate',
  );
  if (providerFailures.length > 0) {
    actions.push(
      `provider delivery unresolved: ${providerFailures.map((finding) => `${finding.kind}: ${finding.path}`).join('; ')}`,
    );
  } else {
    const results = await injectAll(
      providers.filter((provider) => provider.instructFile !== 'AGENTS.md'),
      projectRoot,
      'project',
      providerDelivery.content,
    );
    for (const [filePath, action] of results) actions.push(`${basename(filePath)} (${action})`);
  }

  return {
    action: actions.length > 0 ? 'repaired' : 'created',
    path: agentsMdPath,
    details: actions.join('; '),
  };
}

// ── Contributor project injection block (ADR-029) ────────────────────

/**
 * Probe whether the dev CLI binary is on PATH and responsive.
 * Returns an object with availability and version (or error details).
 * Non-blocking best-effort: returns { available: false } on any failure.
 */
function probeDevCli(devCli: string): { available: boolean; version?: string; error?: string } {
  const pathDirs = (process.env['PATH'] ?? '').split(':').filter(Boolean);
  const onPath = pathDirs.some((dir) => existsSync(join(dir, devCli)));
  if (!onPath) return { available: false, error: 'not on PATH' };
  try {
    const version = execFileSync(devCli, ['--version'], { timeout: 5000 }).toString().trim();
    return { available: true, version };
  } catch (err) {
    return { available: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Build a smart, contextual contributor block for AGENTS.md injection.
 * Returns null if this is not a contributor project.
 *
 * The block is INFORMATIONAL, not prescriptive. It tells agents:
 *   - This is the CLEO source repo (contributor project)
 *   - cleo-dev is available (or not, with reason)
 *   - Prefer cleo-dev for unreleased features, but fall back to cleo if
 *     the dev build is broken or unavailable
 *
 * This avoids the trap where a hardcoded "ALWAYS use cleo-dev" instruction
 * sends agents into a loop when the dev build has compile errors.
 */
export function buildContributorInjectionBlock(projectRoot: string): string | null {
  const configPath = join(projectRoot, '.cleo', 'config.json');
  if (!existsSync(configPath)) return null;
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf-8')) as {
      contributor?: { isContributorProject?: boolean; devCli?: string };
    };
    if (!config.contributor?.isContributorProject) return null;
    const devCli = config.contributor.devCli ?? 'cleo-dev';

    const probe = probeDevCli(devCli);

    const lines: string[] = [
      '',
      '# CLEO Contributor Project — Dev Channel Available',
      '',
      'This project IS the CLEO source repository. Two CLEO channels are available:',
      '',
      `- **\`${devCli}\`** (local dev build) — reflects the current branch, may include unreleased operations`,
      '- **`cleo`** (production `@cleocode/cleo@latest`) — stable published version',
      '',
    ];

    if (probe.available) {
      lines.push(
        `**Dev channel status**: healthy (\`${devCli} --version\`: ${probe.version})`,
        '',
        `Prefer \`${devCli}\` when working on unreleased features or testing new operations.`,
        'Fall back to `cleo` if the dev build is broken or returns errors.',
      );
    } else {
      lines.push(
        `**Dev channel status**: unavailable (${probe.error})`,
        '',
        'Use `cleo` (production) until the dev build is fixed.',
        `To install the dev channel: \`./install.sh --dev\``,
      );
    }

    return lines.join('\n');
  } catch {
    return null;
  }
}

// ── Check injection health ───────────────────────────────────────────

/**
 * Verify injection health: AGENTS.md exists, has CAAMP markers,
 * markers are balanced, and @ references resolve.
 *
 * Combines logic from doctor/checks.ts checkAgentsMdHub,
 * checkCaampMarkerIntegrity, and checkAtReferenceTargetExists.
 */
export function checkInjection(projectRoot: string): InjectionCheckResult {
  const agentsMdPath = join(projectRoot, 'AGENTS.md');

  // Check 1: AGENTS.md exists
  if (!existsSync(agentsMdPath)) {
    return {
      id: 'injection_health',
      category: 'configuration',
      status: 'warning',
      message: 'AGENTS.md not found in project root',
      details: { path: agentsMdPath, exists: false },
      fix: 'cleo upgrade',
    };
  }

  // Check 2: AGENTS.md is readable
  let content: string;
  try {
    content = readFileSync(agentsMdPath, 'utf-8');
  } catch {
    return {
      id: 'injection_health',
      category: 'configuration',
      status: 'warning',
      message: 'AGENTS.md exists but is not readable',
      details: { path: agentsMdPath, readable: false },
      fix: `chmod +r ${agentsMdPath}`,
    };
  }

  // Check 3: Has CAAMP markers
  const startCount = (content.match(/<!-- CAAMP:START -->/g) || []).length;
  const endCount = (content.match(/<!-- CAAMP:END -->/g) || []).length;

  // Damaged markers (e.g. a lost leading `<`) are invisible to the strict
  // counts above but still delimit a block the injector will duplicate, so
  // they are detected explicitly and repaired rather than re-injected (T12051).
  const tolerantStart = (content.match(new RegExp(CAAMP_DAMAGED_START_PATTERN_SOURCE, 'gmi')) ?? [])
    .length;
  const tolerantEnd = (content.match(new RegExp(CAAMP_DAMAGED_END_PATTERN_SOURCE, 'gmi')) ?? [])
    .length;
  const damagedCount = tolerantStart - startCount + (tolerantEnd - endCount);

  if (damagedCount > 0) {
    return {
      id: 'injection_health',
      category: 'configuration',
      status: 'warning',
      message: `AGENTS.md has ${damagedCount} damaged CAAMP marker(s)`,
      details: { path: agentsMdPath, damagedCount, startCount, endCount },
      fix: 'cleo caamp repair',
    };
  }

  if (tolerantStart === 0) {
    return {
      id: 'injection_health',
      category: 'configuration',
      status: 'warning',
      message: 'AGENTS.md exists but has no CAAMP markers',
      details: { path: agentsMdPath, hasCaampMarker: false },
      fix: 'cleo upgrade',
    };
  }

  // Check 4: Markers are balanced
  if (startCount !== endCount) {
    return {
      id: 'injection_health',
      category: 'configuration',
      status: 'warning',
      message: `CAAMP markers unbalanced: ${startCount} START vs ${endCount} END`,
      details: { path: agentsMdPath, startCount, endCount },
      fix: 'cleo caamp repair',
    };
  }

  // Check 4b: Exactly one block. More than one means the referenced protocol
  // text is loaded into every agent's context more than once.
  if (startCount > 1) {
    return {
      id: 'injection_health',
      category: 'configuration',
      status: 'warning',
      message: `AGENTS.md has ${startCount} CAAMP blocks (expected 1) — protocol injected ${startCount}×`,
      details: { path: agentsMdPath, startCount, endCount },
      fix: 'cleo caamp repair',
    };
  }

  // Check 5: @ references resolve
  const caampMatch = content.match(/<!-- CAAMP:START -->([\s\S]*?)<!-- CAAMP:END -->/);
  if (caampMatch) {
    const block = caampMatch[1];
    const refs = block.match(/^@(.+)$/gm) || [];
    const missing: string[] = [];

    for (const ref of refs) {
      const rawPath = ref.slice(1).trim();
      const resolvedPath =
        rawPath.startsWith('~/') || rawPath.startsWith('~\\')
          ? join(homedir(), rawPath.slice(2))
          : join(projectRoot, rawPath);

      if (!existsSync(resolvedPath)) {
        missing.push(rawPath);
      }
    }

    if (missing.length > 0) {
      return {
        id: 'injection_health',
        category: 'configuration',
        status: 'warning',
        message: `Missing @ reference targets: ${missing.join(', ')}`,
        details: { path: agentsMdPath, missing, totalRefs: refs.length },
        fix: 'cleo upgrade',
      };
    }
  }

  // Also check CLAUDE.md CAAMP marker integrity
  const claudeMdPath = join(projectRoot, 'CLAUDE.md');
  if (existsSync(claudeMdPath)) {
    try {
      const claudeContent = readFileSync(claudeMdPath, 'utf-8');
      const cStartCount = (claudeContent.match(/<!-- CAAMP:START -->/g) || []).length;
      const cEndCount = (claudeContent.match(/<!-- CAAMP:END -->/g) || []).length;

      if (cStartCount !== cEndCount) {
        return {
          id: 'injection_health',
          category: 'configuration',
          status: 'warning',
          message: `CLAUDE.md CAAMP markers unbalanced: ${cStartCount} START vs ${cEndCount} END`,
          details: { file: 'CLAUDE.md', startCount: cStartCount, endCount: cEndCount },
          fix: 'cleo caamp repair',
        };
      }

      if (cStartCount === 0) {
        return {
          id: 'injection_health',
          category: 'configuration',
          status: 'warning',
          message: 'CLAUDE.md has no CAAMP markers',
          details: { file: 'CLAUDE.md', hasCaampMarker: false },
          fix: 'cleo upgrade',
        };
      }
    } catch {
      // CLAUDE.md not readable — non-fatal
    }
  }

  return {
    id: 'injection_health',
    category: 'configuration',
    status: 'passed',
    message: 'CAAMP injection healthy: markers balanced, references resolve',
    details: { path: agentsMdPath, hasCaampMarker: true, markersBalanced: true },
    fix: null,
  };
}

// ── Global provider instruction freshness (T12378) ───────────────────

/** Exact command that regenerates every global provider instruction file. */
export const GLOBAL_INSTRUCTION_REMEDY = 'cleo install-global';

/** Exact command that restores a missing or dead `caamp` binary. */
export const CAAMP_BINARY_REMEDY = 'npm install -g @cleocode/caamp';

/** Default wall-clock bound for the automatic refresh. */
const GLOBAL_REFRESH_TIMEOUT_MS = 2000;

/**
 * Options for {@link refreshStaleGlobalInstructions}.
 */
export interface RefreshStaleGlobalInstructionsOptions {
  /** Wall-clock bound in milliseconds. @defaultValue 2000 */
  timeoutMs?: number;
  /** Providers to scan and refresh. @defaultValue every installed provider */
  providers?: Provider[];
  /** Run even under Vitest (tests pass a temp HOME and explicit providers). @defaultValue false */
  force?: boolean;
}

/** Remedy text for hand-appended copies of managed content. */
function duplicateRemedy(files: string[]): string {
  return `Remove the hand-appended copy of managed content below <!-- CAAMP:END --> in: ${files.join(', ')}`;
}

/** A failed refresh report carrying the regeneration remedy. */
function failedRefresh(reason: string): GlobalInstructionRefreshReport {
  return {
    status: 'failed',
    stale: [],
    duplicates: [],
    updated: [],
    reason,
    remedy: GLOBAL_INSTRUCTION_REMEDY,
  };
}

/** Scan, then regenerate only when a file is stale or unembedded. */
async function runGlobalRefresh(providers?: Provider[]): Promise<GlobalInstructionRefreshReport> {
  const { checkGlobalInstructionStaleness, syncGlobalInstructions } = await import(
    '@cleocode/caamp'
  );
  const scan = await checkGlobalInstructionStaleness({ providers });
  const report: GlobalInstructionRefreshReport = {
    status: 'current',
    stale: scan.needsSync,
    duplicates: scan.duplicates,
    updated: [],
    ...(scan.duplicates.length > 0 ? { remedy: duplicateRemedy(scan.duplicates) } : {}),
  };
  if (scan.needsSync.length === 0) return report;

  const result = await syncGlobalInstructions({ providers });
  report.updated = result.files
    .filter((file) => file.action !== 'intact' && file.action !== 'failed')
    .map((file) => file.path);
  const failed = result.files.filter((file) => file.action === 'failed');
  if (result.status === 'synced' && failed.length === 0) {
    report.status = 'refreshed';
    return report;
  }
  report.status = 'failed';
  report.reason =
    result.status === 'unresolved'
      ? `delivery unresolved: ${result.findings.map((f) => `${f.kind}: ${f.path}`).join('; ')}`
      : failed.length > 0
        ? failed.map((file) => `${file.path}: ${file.error ?? 'write failed'}`).join('; ')
        : `sync status ${result.status}`;
  report.remedy = GLOBAL_INSTRUCTION_REMEDY;
  return report;
}

/**
 * Regenerate the global provider instruction files when a stamped source has
 * changed since delivery — the automatic path behind `cleo session start` and
 * `cleo briefing`.
 *
 * @remarks
 * Before T12378 nothing regenerated those files when `~/.agents/AGENTS.md` or
 * `CLEO-INJECTION.md` changed: an owner rule added to the hub never reached the
 * 22 provider files that embed it. This runs the cheap scan
 * (`checkGlobalInstructionStaleness` — one read per provider file, one hash per
 * stamped source, no reference expansion) and, only when a file is stale or
 * unembedded, the single shared regenerator `syncGlobalInstructions`.
 *
 * It is bounded (`timeoutMs`), never throws, and writes nothing to stdout: the
 * outcome is returned for the caller to place in its envelope. Set
 * `CLEO_INSTRUCTION_AUTOREFRESH=0` to disable it. Under Vitest it is skipped
 * unless `force` is set, so a test can never rewrite the real provider files.
 *
 * @param options - Bound, targets and test override.
 * @returns What was found and what was refreshed.
 *
 * @example
 * ```typescript
 * const report = await refreshStaleGlobalInstructions();
 * if (report.status === 'failed') process.stderr.write(`${report.remedy}\n`);
 * ```
 *
 * @task T12378
 */
export async function refreshStaleGlobalInstructions(
  options: RefreshStaleGlobalInstructionsOptions = {},
): Promise<GlobalInstructionRefreshReport> {
  const skipped = (reason: string): GlobalInstructionRefreshReport => ({
    status: 'skipped',
    stale: [],
    duplicates: [],
    updated: [],
    reason,
  });
  if (process.env['CLEO_INSTRUCTION_AUTOREFRESH'] === '0') {
    return skipped('disabled by CLEO_INSTRUCTION_AUTOREFRESH=0');
  }
  if (process.env['VITEST'] && !options.force) return skipped('test environment');

  const timeoutMs = options.timeoutMs ?? GLOBAL_REFRESH_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<GlobalInstructionRefreshReport>((resolveTimeout) => {
    timer = setTimeout(
      () => resolveTimeout(failedRefresh(`timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    timer.unref?.();
  });
  try {
    return await Promise.race([
      runGlobalRefresh(options.providers).catch((err: Error) => failedRefresh(err.message)),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Doctor check: are the global provider instruction files current, and does
 * any carry a hand-appended copy of managed content?
 *
 * @remarks
 * Read-only — it runs the cheap staleness scan and never writes.
 *
 * @returns One result for delivery freshness and one for duplicates.
 *
 * @task T12378
 */
export async function checkGlobalInstructionDelivery(): Promise<InjectionCheckResult[]> {
  let scan: GlobalInstructionStalenessReport;
  try {
    const { checkGlobalInstructionStaleness } = await import('@cleocode/caamp');
    scan = await checkGlobalInstructionStaleness();
  } catch (err) {
    return [
      {
        id: 'global_instruction_delivery',
        category: 'configuration',
        status: 'warning',
        message: `Global instruction delivery could not be checked: ${err instanceof Error ? err.message : String(err)}`,
        details: {},
        fix: GLOBAL_INSTRUCTION_REMEDY,
      },
    ];
  }

  const delivery: InjectionCheckResult =
    scan.needsSync.length === 0
      ? {
          id: 'global_instruction_delivery',
          category: 'configuration',
          status: 'passed',
          message: `Global provider instructions current (${scan.files.length} file(s) checked)`,
          details: { files: scan.files.length },
          fix: null,
        }
      : {
          id: 'global_instruction_delivery',
          category: 'configuration',
          status: 'warning',
          message: `Stale global provider instructions: ${scan.needsSync.join(', ')}`,
          details: {
            files: scan.files
              .filter((file) => scan.needsSync.includes(file.path))
              .map((file) => ({ path: file.path, state: file.state, sources: file.staleSources })),
          },
          fix: GLOBAL_INSTRUCTION_REMEDY,
        };

  const duplicates: InjectionCheckResult =
    scan.duplicates.length === 0
      ? {
          id: 'global_instruction_duplicates',
          category: 'configuration',
          status: 'passed',
          message: 'No managed content duplicated outside CAAMP blocks',
          details: {},
          fix: null,
        }
      : {
          id: 'global_instruction_duplicates',
          category: 'configuration',
          status: 'warning',
          message: `Managed content duplicated outside <!-- CAAMP:END --> (not removed automatically): ${scan.duplicates.join(', ')}`,
          details: { files: scan.duplicates },
          fix: duplicateRemedy(scan.duplicates),
        };

  return [delivery, duplicates];
}

/**
 * Doctor check: is a working `caamp` binary on PATH?
 *
 * @remarks
 * A dangling `caamp` symlink (left behind when the package it pointed into was
 * removed or moved) makes every `caamp …` remedy fail with a confusing
 * "No such file or directory". Reports the first working binary, else the dead
 * links found, else that none exists — each with the exact remedy.
 *
 * @param pathEnv - PATH to search. @defaultValue `process.env.PATH`
 * @returns The check result.
 *
 * @example
 * ```typescript
 * const check = checkCaampBinary();
 * if (check.fix) process.stderr.write(`${check.fix}\n`);
 * ```
 *
 * @task T12378
 */
export function checkCaampBinary(
  pathEnv: string = process.env['PATH'] ?? '',
): InjectionCheckResult {
  const names = process.platform === 'win32' ? ['caamp.cmd', 'caamp.exe', 'caamp'] : ['caamp'];
  const dead: string[] = [];
  for (const dir of pathEnv.split(delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = join(dir, name);
      let isLink: boolean;
      try {
        isLink = lstatSync(candidate).isSymbolicLink();
      } catch {
        continue; // nothing at this path
      }
      if (existsSync(candidate)) {
        return {
          id: 'caamp_binary',
          category: 'dependencies',
          status: 'passed',
          message: `caamp binary: ${candidate}`,
          details: { path: candidate },
          fix: null,
        };
      }
      if (isLink) dead.push(candidate);
    }
  }
  if (dead.length > 0) {
    return {
      id: 'caamp_binary',
      category: 'dependencies',
      status: 'failed',
      message: `caamp symlink is dead (target missing): ${dead.join(', ')}`,
      details: { dead },
      fix: `rm ${dead.join(' ')} && ${CAAMP_BINARY_REMEDY}`,
    };
  }
  return {
    id: 'caamp_binary',
    category: 'dependencies',
    status: 'warning',
    message: 'caamp binary not found on PATH',
    details: {},
    fix: CAAMP_BINARY_REMEDY,
  };
}
