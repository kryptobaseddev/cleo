/**
 * skills install command - LAFS-compliant with JSON-first output
 */

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pushWarning } from '@cleocode/lafs';
import type { Command } from 'commander';
import pc from 'picocolors';
import {
  dispatchInstallSkillAcrossProviders,
  resolveDefaultTargetProviders,
} from '../../core/harness/index.js';
import {
  buildEnvelope,
  ErrorCategories,
  ErrorCodes,
  emitError,
  emitJsonError,
  type MVILevel,
  outputSuccess,
  resolveFormat,
} from '../../core/lafs.js';
import { MarketplaceClient } from '../../core/marketplace/client.js';
import { formatNetworkError } from '../../core/network/fetch.js';
import { buildSkillSubPathCandidates } from '../../core/paths/standard.js';
import { getInstalledProviders } from '../../core/registry/detection.js';
import { getProvider } from '../../core/registry/providers.js';
import * as catalog from '../../core/skills/catalog.js';
import { discoverSkill } from '../../core/skills/discovery.js';
import { recordSkillInstall } from '../../core/skills/lock.js';
import { cloneRepo } from '../../core/sources/github.js';
import { cloneGitLabRepo } from '../../core/sources/gitlab.js';
import { isMarketplaceScoped, parseSource } from '../../core/sources/parser.js';
import type { Provider, SourceType } from '../../types.js';

interface InstallResultItem {
  name: string;
  scopedName: string;
  canonicalPath: string;
  providers: string[];
}

interface FailedResultItem {
  name: string;
  error: string;
}

interface InstallSummary {
  installed: InstallResultItem[];
  failed: FailedResultItem[];
  count: {
    installed: number;
    failed: number;
    total: number;
  };
}

// ---------------------------------------------------------------------------
// Inline trust-gate bridge (T9751 — replaces trust-gate-adapter.ts)
//
// `@cleocode/core` is NOT a static dependency of caamp (caamp's package.json
// intentionally omits it to keep the static module graph acyclic — core
// depends on caamp, not the other way around). The old adapter at
// `core/skills/trust-gate-adapter.ts` existed solely to wrap a dynamic
// `import('@cleocode/core')` so callers got typed surfaces. Wave D collapses
// that 229-LOC indirection: the same dynamic-import pattern lives inline
// here, and the install command calls CORE's canonical helpers directly.
// ---------------------------------------------------------------------------

/**
 * Local mirror of `@cleocode/core`'s `ScanResult` field-set. Declared inline
 * (not via `typeof import('@cleocode/core')`) because we MUST NOT statically
 * depend on core. Field set + semantics match exactly; if core's shape ever
 * drifts the dynamic-import resolution would surface the breakage.
 */
interface AdapterScanResult {
  readonly skillName: string;
  readonly source: string;
  readonly trustLevel: 'builtin' | 'trusted' | 'community' | 'agent-created';
  readonly verdict: 'safe' | 'caution' | 'dangerous';
  readonly findings: ReadonlyArray<{
    readonly patternId: string;
    readonly severity: string;
    readonly category: string;
    readonly file: string;
    readonly line: number;
    readonly match: string;
    readonly description: string;
  }>;
  readonly scannedAt: string;
  readonly summary: string;
}

/** Local mirror of `@cleocode/core`'s `FederationInstallGateResult`. */
interface FederationGateResult {
  readonly decision: 'allow' | 'block-checksum' | 'prompt-first-install';
  readonly reason: string;
  readonly peer: { readonly url: string; readonly trust: string } | null;
  readonly isFederationSource: boolean;
  readonly computedChecksum: string | null;
  readonly expectedChecksum: string | null;
}

/** Composite decision returned by {@link evaluateSkillTrustGate}. */
interface TrustGateOutcome {
  readonly decision: 'allow' | 'block' | 'ask';
  readonly reason: string;
  readonly scan: AdapterScanResult;
}

/**
 * Minimal structural typing of the core surface we call through the
 * dynamic import. Kept narrow to limit blast radius if core's API drifts.
 */
interface CoreSkillsGuardShape {
  readonly scanSkill: (path: string, source: string) => AdapterScanResult;
  readonly shouldAllowInstall: (
    scan: AdapterScanResult,
    force: boolean,
  ) => { readonly decision: 'allow' | 'block' | 'ask'; readonly reason: string };
  readonly recordTrustBypass: (scan: AdapterScanResult, reason: string | null) => unknown;
  readonly evaluateFederationInstallGate: (opts: {
    source: string;
    artefactPath?: string;
    expectedChecksum?: string | null;
    approveNewSource?: boolean;
  }) => FederationGateResult;
}

/** Module-scoped cache so repeated installs pay the resolve cost once. */
let cachedCore: CoreSkillsGuardShape | null | undefined;

/**
 * Pluggable resolver for `@cleocode/core`. Production code uses the default
 * which combines `createRequire(import.meta.url).resolve()` (existence check)
 * with `import('@cleocode/core' as string)` (dynamic load). Tests override
 * via {@link __testing.setCoreResolver} to simulate resolution failure
 * without touching the real module graph.
 *
 * @internal
 */
type CoreResolver = () => Promise<CoreSkillsGuardShape>;

const defaultCoreResolver: CoreResolver = async () => {
  const require = createRequire(import.meta.url);
  require.resolve('@cleocode/core');
  // The `as string` cast keeps the dependency out of the static module graph;
  // tsc treats this as a fully opaque dynamic import.
  return (await import('@cleocode/core' as string)) as CoreSkillsGuardShape;
};

let coreResolver: CoreResolver = defaultCoreResolver;

/**
 * Lazily resolve `@cleocode/core`. Returns `null` when caamp runs outside
 * the cleo monorepo and core is unavailable — callers MUST degrade to
 * `allow` rather than fail-closed (refusing legitimate standalone caamp
 * installs purely because core is missing would break the package).
 *
 * @remarks
 * Resolution strategy (T9770):
 * 1. `createRequire(import.meta.url).resolve('@cleocode/core')` to check
 *    whether the module is reachable from caamp's runtime location. This
 *    uses Node's standard resolution rules so symlinked workspaces, pnpm
 *    global installs, and direct installs all resolve correctly when core
 *    IS listed as a `dependency` / `peerDependency`.
 * 2. If `resolve()` succeeds, dynamically `import()` the module. The string
 *    is still cast to `string` so tsc doesn't lift `@cleocode/core` into the
 *    static module graph (avoids the core ↔ caamp circular dep at build
 *    time — core depends on caamp, not the other way around).
 * 3. On any failure the function returns `null` and routes a structured
 *    warning into the active LAFS {@link WarningCollector} via
 *    {@link pushWarning}. NO stderr writes — JSON-emitting commands stay
 *    parser-clean.
 */
async function resolveCore(): Promise<CoreSkillsGuardShape | null> {
  if (cachedCore !== undefined) return cachedCore;
  try {
    cachedCore = await coreResolver();
  } catch (err) {
    cachedCore = null;
    pushWarning({
      code: 'W_CORE_UNAVAILABLE',
      severity: 'warn',
      message:
        'caamp running without @cleocode/core — trust gate skipped (skill installs not security-checked)',
      context: {
        error: err instanceof Error ? err.message : String(err),
      },
    });
  }
  return cachedCore;
}

/**
 * Run the skills-guard scan + INSTALL_POLICY gate against a local skill path.
 *
 * @param localPath - Absolute path to the skill root.
 * @param source    - Source identifier (drives trust-level resolution).
 * @param force     - Operator `--force` override (flips `block` → `allow`).
 */
async function evaluateSkillTrustGate(
  localPath: string,
  source: string,
  force: boolean = false,
): Promise<TrustGateOutcome> {
  const core = await resolveCore();
  if (!core) {
    return {
      decision: 'allow',
      reason: 'Trust gate skipped — @cleocode/core not available',
      scan: {
        skillName: localPath.split('/').filter(Boolean).pop() ?? localPath,
        source,
        trustLevel: 'community',
        verdict: 'safe',
        findings: [],
        scannedAt: new Date().toISOString(),
        summary: 'core-unavailable',
      },
    };
  }
  const scan = core.scanSkill(localPath, source);
  const gate = core.shouldAllowInstall(scan, force);
  return { decision: gate.decision, reason: gate.reason, scan };
}

/**
 * Run the federation install gate (T9732) — first-install prompt detection +
 * sha256 checksum validation. Falls through to `allow` when core is missing.
 */
async function evaluateFederationGate(
  source: string,
  opts: {
    readonly artefactPath?: string;
    readonly expectedChecksum?: string | null;
    readonly approveNewSource?: boolean;
  } = {},
): Promise<FederationGateResult> {
  const core = await resolveCore();
  if (!core) {
    return {
      decision: 'allow',
      reason: 'Federation gate skipped — @cleocode/core not available',
      peer: null,
      isFederationSource: false,
      computedChecksum: null,
      expectedChecksum: null,
    };
  }
  return core.evaluateFederationInstallGate({
    source,
    artefactPath: opts.artefactPath,
    expectedChecksum: opts.expectedChecksum,
    approveNewSource: opts.approveNewSource,
  });
}

/**
 * Append a bypass entry to `.cleo/audit/skill-trust-bypass.jsonl`. No-op
 * when core is unavailable. Failures during writing are routed to the
 * active LAFS {@link WarningCollector} as `W_AUDIT_LOG_FAILED` so an
 * audit-log failure never breaks a real install AND never pollutes stderr
 * with `[caamp] WARNING:` lines that mangle JSON parsers (T9770).
 */
async function recordSkillTrustBypass(
  scan: AdapterScanResult,
  reason: string | null = null,
): Promise<void> {
  const core = await resolveCore();
  if (!core) return;
  try {
    core.recordTrustBypass(scan, reason);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    pushWarning({
      code: 'W_AUDIT_LOG_FAILED',
      severity: 'warn',
      message: 'trust-bypass audit record failed',
      context: { error: msg },
    });
  }
}

/**
 * Test-only exports — exposes the warning-emitting internals so tests can
 * verify they route into the active LAFS {@link WarningCollector} without
 * polluting stderr.
 *
 * @internal
 */
export const __testing = {
  /** Resets the module-scoped core cache so each test gets a clean slate. */
  resetCoreCache(): void {
    cachedCore = undefined;
  },
  /** Overrides the core cache with a test fixture (or `null` to simulate "unavailable"). */
  setCoreCache(value: CoreSkillsGuardShape | null): void {
    cachedCore = value;
  },
  /**
   * Replaces the resolver. Pass `null` to restore the production resolver.
   * Tests use this to simulate `@cleocode/core` being absent at runtime.
   */
  setCoreResolver(resolver: CoreResolver | null): void {
    coreResolver = resolver ?? defaultCoreResolver;
  },
  resolveCore,
  recordSkillTrustBypass,
};

/**
 * Registers the `skills install` subcommand for installing skills from various sources.
 *
 * @remarks
 * Supports GitHub URLs, owner/repo shorthand, marketplace scoped names, and skill library profiles.
 * Uses the canonical+symlink model to store skills once and symlink to each targeted agent.
 *
 * @param parent - The parent `skills` Command to attach the install subcommand to
 *
 * @example
 * ```bash
 * caamp skills install owner/repo
 * caamp skills install @author/skill-name --agent claude-code
 * caamp skills install --profile recommended --all
 * ```
 *
 * @public
 */
export function registerSkillsInstall(parent: Command): void {
  parent
    .command('install')
    .description('Install a skill from GitHub, URL, marketplace, or registered skill library')
    .argument('[source]', 'Skill source (GitHub URL, owner/repo, @author/name, skill-name)')
    .option(
      '-a, --agent <name>',
      'Target specific agent(s)',
      (v, prev: string[]) => [...prev, v],
      [],
    )
    .option('-g, --global', 'Install globally')
    .option('-y, --yes', 'Skip confirmation')
    .option('--all', 'Install to all detected agents')
    .option(
      '--profile <name>',
      'Install a skill library profile (minimal, core, recommended, full)',
    )
    .option(
      '--force',
      'Override trust-gate block decisions (audited to .cleo/audit/skill-trust-bypass.jsonl)',
    )
    .option(
      '--allow-new-source',
      'Bypass first-install confirmation prompt for unknown federation sources (non-TTY safe)',
    )
    .option('--json', 'Output as JSON (default)')
    .option('--human', 'Output in human-readable format')
    .action(
      async (
        source: string | undefined,
        opts: {
          agent: string[];
          global?: boolean;
          yes?: boolean;
          all?: boolean;
          profile?: string;
          force?: boolean;
          allowNewSource?: boolean;
          json?: boolean;
          human?: boolean;
        },
      ) => {
        const operation = 'skills.install';
        const mvi: import('../../core/lafs.js').MVILevel = 'standard';

        let format: 'json' | 'human';
        try {
          format = resolveFormat({
            jsonFlag: opts.json ?? false,
            humanFlag: opts.human ?? false,
            projectDefault: 'json',
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          emitJsonError(
            operation,
            mvi,
            ErrorCodes.FORMAT_CONFLICT,
            message,
            ErrorCategories.VALIDATION,
          );
          process.exit(1);
        }

        // Determine target providers. Default (no --agent, no --all) prefers
        // the registry's primary harness when it is installed; otherwise it
        // falls back to the legacy installed-providers list.
        let providers: Provider[];

        if (opts.all) {
          providers = getInstalledProviders();
        } else if (opts.agent.length > 0) {
          providers = opts.agent
            .map((a) => getProvider(a))
            .filter((p): p is Provider => p !== undefined);
        } else {
          providers = resolveDefaultTargetProviders();
        }

        if (providers.length === 0) {
          const message = 'No target providers found. Use --agent or --all.';
          if (format === 'json') {
            emitError(
              operation,
              mvi,
              ErrorCodes.PROVIDER_NOT_FOUND,
              message,
              ErrorCategories.NOT_FOUND,
            );
          }
          console.error(pc.red(message));
          process.exit(1);
        }

        // Handle --profile: install an entire skill library profile
        if (opts.profile) {
          await handleProfileInstall(
            opts.profile,
            providers,
            opts.global ?? false,
            format,
            operation,
            mvi,
          );
          return;
        }

        // Require source when not using --profile
        if (!source) {
          const message = 'Missing required argument: source';
          if (format === 'json') {
            emitError(
              operation,
              mvi,
              ErrorCodes.INVALID_INPUT,
              message,
              ErrorCategories.VALIDATION,
            );
          }
          console.error(pc.red(message));
          console.log(
            pc.dim('Usage: caamp skills install <source> or caamp skills install --profile <name>'),
          );
          process.exit(1);
        }

        if (format === 'human') {
          console.log(pc.dim(`Installing to ${providers.length} provider(s)...`));
        }

        let localPath: string | undefined;
        let cleanup: (() => Promise<void>) | undefined;
        let skillName: string;
        let sourceValue: string;
        let sourceType: SourceType;

        // Handle marketplace scoped names
        if (isMarketplaceScoped(source)) {
          const sourceResult = await handleMarketplaceSource(
            source,
            providers,
            opts.global ?? false,
            format,
            operation,
            mvi,
          );

          if (sourceResult.success) {
            localPath = sourceResult.localPath;
            cleanup = sourceResult.cleanup;
            skillName = sourceResult.skillName;
            sourceValue = sourceResult.sourceValue;
            sourceType = sourceResult.sourceType;
          } else {
            process.exit(1);
          }
        } else {
          // Parse source
          const parsed = parseSource(source);
          skillName = parsed.inferredName;
          sourceValue = parsed.value;
          sourceType = parsed.type;

          if (parsed.type === 'github' && parsed.owner && parsed.repo) {
            try {
              const result = await cloneRepo(parsed.owner, parsed.repo, parsed.ref, parsed.path);
              localPath = result.localPath;
              cleanup = result.cleanup;
            } catch (error) {
              const message = `Failed to clone GitHub repository: ${formatNetworkError(error)}`;
              if (format === 'json') {
                emitJsonError(
                  operation,
                  mvi,
                  ErrorCodes.NETWORK_ERROR,
                  message,
                  ErrorCategories.TRANSIENT,
                );
              }
              console.error(pc.red(message));
              process.exit(1);
            }
          } else if (parsed.type === 'gitlab' && parsed.owner && parsed.repo) {
            try {
              const result = await cloneGitLabRepo(
                parsed.owner,
                parsed.repo,
                parsed.ref,
                parsed.path,
              );
              localPath = result.localPath;
              cleanup = result.cleanup;
            } catch (error) {
              const message = `Failed to clone GitLab repository: ${formatNetworkError(error)}`;
              if (format === 'json') {
                emitJsonError(
                  operation,
                  mvi,
                  ErrorCodes.NETWORK_ERROR,
                  message,
                  ErrorCategories.TRANSIENT,
                );
              }
              console.error(pc.red(message));
              process.exit(1);
            }
          } else if (parsed.type === 'local') {
            localPath = parsed.value;
            // Read SKILL.md for the authoritative name
            const discovered = await discoverSkill(localPath);
            if (discovered) {
              skillName = discovered.name;
            }
          } else if (parsed.type === 'package') {
            // Check registered skill library for this skill name
            if (!catalog.isCatalogAvailable()) {
              const message =
                'No skill library registered. Register one with registerSkillLibraryFromPath() or set CAAMP_SKILL_LIBRARY env var.';
              if (format === 'json') {
                emitJsonError(
                  operation,
                  mvi,
                  ErrorCodes.INVALID_INPUT,
                  message,
                  ErrorCategories.VALIDATION,
                );
              }
              console.error(pc.red(message));
              process.exit(1);
            }
            const catalogSkill = catalog.getSkill(parsed.inferredName);
            if (catalogSkill) {
              localPath = catalog.getSkillDir(catalogSkill.name);
              skillName = catalogSkill.name;
              sourceValue = `library:${catalogSkill.name}`;
              sourceType = 'library';
              if (format === 'human') {
                console.log(
                  `  Found in catalog: ${pc.bold(catalogSkill.name)} v${catalogSkill.version} (${pc.dim(catalogSkill.category)})`,
                );
              }
            } else {
              const message = `Skill not found in catalog: ${parsed.inferredName}`;
              if (format === 'json') {
                emitJsonError(
                  operation,
                  mvi,
                  ErrorCodes.SKILL_NOT_FOUND,
                  message,
                  ErrorCategories.NOT_FOUND,
                  {
                    availableSkills: catalog.listSkills(),
                  },
                );
              }
              console.error(pc.red(message));
              console.log(pc.dim('Available skills: ' + catalog.listSkills().join(', ')));
              process.exit(1);
            }
          } else {
            const message = `Unsupported source type: ${parsed.type}`;
            if (format === 'json') {
              emitJsonError(
                operation,
                mvi,
                ErrorCodes.INVALID_FORMAT,
                message,
                ErrorCategories.VALIDATION,
              );
            }
            console.error(pc.red(message));
            process.exit(1);
          }
        }

        try {
          if (!localPath) {
            const message = 'No local skill path resolved for installation';
            if (format === 'json') {
              emitJsonError(
                operation,
                mvi,
                ErrorCodes.INTERNAL_ERROR,
                message,
                ErrorCategories.INTERNAL,
              );
            }
            console.error(pc.red(message));
            process.exit(1);
          }

          // T9732 — federation install gate.
          // Runs BEFORE the trust gate so a checksum mismatch or unknown
          // federation source never reaches the skills-guard pass — saving
          // wasted scans on bytes the operator hasn't authorised yet.
          if (sourceType !== 'library' && sourceType !== 'package') {
            const fedGate = await evaluateFederationGate(sourceValue, {
              artefactPath: localPath,
              approveNewSource: opts.allowNewSource === true,
            });
            if (fedGate.decision === 'block-checksum') {
              const message = `Federation install blocked: ${fedGate.reason}`;
              if (format === 'json') {
                emitJsonError(
                  operation,
                  mvi,
                  ErrorCodes.FEDERATION_CHECKSUM_MISMATCH,
                  message,
                  ErrorCategories.VALIDATION,
                  {
                    expectedChecksum: fedGate.expectedChecksum,
                    computedChecksum: fedGate.computedChecksum,
                  },
                );
              }
              console.error(pc.red(message));
              process.exit(1);
            }
            if (fedGate.decision === 'prompt-first-install') {
              // Non-TTY contexts (CI, agents) MUST supply --allow-new-source.
              // We do NOT prompt interactively here because the JSON-first
              // CLI mode would mangle the prompt rendering.
              const message = `${fedGate.reason} Use --allow-new-source to approve in non-interactive contexts.`;
              if (format === 'json') {
                emitJsonError(
                  operation,
                  mvi,
                  ErrorCodes.FEDERATION_UNKNOWN_SOURCE_INTERACTIVE_REQUIRED,
                  message,
                  ErrorCategories.VALIDATION,
                  { peer: fedGate.peer?.url ?? null },
                );
              }
              console.error(pc.yellow(message));
              process.exit(1);
            }
          }

          // T9730 — skills-guard trust gate.
          // MUST run BEFORE any fs.copy so a blocked install has zero
          // side-effects on the canonical skill store. Library/package
          // sources are trusted-by-construction (they ship with CLEO) so
          // they skip the gate — same posture as Hermes builtin tier.
          if (sourceType !== 'library' && sourceType !== 'package') {
            const gate = await evaluateSkillTrustGate(localPath, sourceValue, opts.force ?? false);
            if (gate.decision === 'block') {
              const message = `Trust gate blocked install: ${gate.reason}`;
              if (format === 'json') {
                const envelope = buildEnvelope(
                  operation,
                  mvi,
                  { scan: gate.scan },
                  {
                    code: ErrorCodes.SKILL_TRUST_GATE_BLOCKED,
                    message,
                    category: ErrorCategories.VALIDATION,
                    retryable: false,
                    retryAfterMs: null,
                    details: {
                      verdict: gate.scan.verdict,
                      trustLevel: gate.scan.trustLevel,
                      findingsCount: gate.scan.findings.length,
                    },
                  },
                );
                console.error(JSON.stringify(envelope, null, 2));
              } else {
                console.error(pc.red(`\n${message}`));
                for (const f of gate.scan.findings.slice(0, 5)) {
                  console.error(
                    pc.dim(
                      `  [${f.severity}] ${f.category} ${f.file}:${f.line} — ${f.description}`,
                    ),
                  );
                }
                console.error(pc.yellow('  Use --force to override (audited).'));
              }
              process.exit(1);
            }
            if (gate.decision === 'ask') {
              const message = `Trust gate requires confirmation: ${gate.reason}`;
              if (format === 'json') {
                emitJsonError(
                  operation,
                  mvi,
                  ErrorCodes.SKILL_TRUST_GATE_BLOCKED,
                  message,
                  ErrorCategories.VALIDATION,
                );
              }
              console.error(pc.red(message));
              process.exit(1);
            }
            if (opts.force === true && gate.scan.verdict !== 'safe') {
              await recordSkillTrustBypass(gate.scan, 'operator --force on caamp skills install');
            }
          }

          const result = await dispatchInstallSkillAcrossProviders(
            localPath,
            skillName!,
            providers,
            opts.global ?? false,
          );

          if (result.success) {
            // Record in lock file
            const isGlobal =
              sourceType === 'library' || sourceType === 'package' ? true : (opts.global ?? false);
            await recordSkillInstall(
              skillName!,
              sourceValue,
              sourceValue,
              sourceType,
              result.linkedAgents,
              result.canonicalPath,
              isGlobal,
            );

            const installedItem: InstallResultItem = {
              name: skillName!,
              scopedName: sourceValue,
              canonicalPath: result.canonicalPath,
              providers: result.linkedAgents,
            };

            const summary: InstallSummary = {
              installed: [installedItem],
              failed: [],
              count: {
                installed: 1,
                failed: 0,
                total: 1,
              },
            };

            if (format === 'json') {
              outputSuccess(operation, mvi, summary);
            } else {
              console.log(pc.green(`\n✓ Installed ${pc.bold(skillName)}`));
              console.log(`  Canonical: ${pc.dim(result.canonicalPath)}`);
              console.log(`  Linked to: ${result.linkedAgents.join(', ')}`);

              if (result.errors.length > 0) {
                console.log(pc.yellow('\nWarnings:'));
                for (const err of result.errors) {
                  console.log(`  ${pc.yellow('!')} ${err}`);
                }
              }
            }
          } else {
            const summary: InstallSummary = {
              installed: [],
              failed: [
                {
                  name: skillName!,
                  error: result.errors.join(', '),
                },
              ],
              count: {
                installed: 0,
                failed: 1,
                total: 1,
              },
            };

            if (format === 'json') {
              const envelope = buildEnvelope(operation, mvi, summary, {
                code: ErrorCodes.INSTALL_FAILED,
                message: result.errors.join(', '),
                category: ErrorCategories.INTERNAL,
                retryable: false,
                retryAfterMs: null,
                details: { skillName, sourceValue },
              });
              console.error(JSON.stringify(envelope, null, 2));
            } else {
              console.log(pc.yellow(`\n✗ Failed to install ${pc.bold(skillName)}`));
              console.log(pc.yellow('Errors:'));
              for (const err of result.errors) {
                console.log(`  ${pc.yellow('!')} ${err}`);
              }
            }
            process.exit(1);
          }
        } finally {
          if (cleanup) await cleanup();
        }
      },
    );
}

async function handleProfileInstall(
  profileName: string,
  providers: Provider[],
  isGlobal: boolean,
  format: 'json' | 'human',
  operation: string,
  mvi: MVILevel,
): Promise<void> {
  if (!catalog.isCatalogAvailable()) {
    const message =
      'No skill library registered. Register one with registerSkillLibraryFromPath() or set CAAMP_SKILL_LIBRARY env var.';
    if (format === 'json') {
      emitError(operation, mvi, ErrorCodes.INVALID_INPUT, message, ErrorCategories.VALIDATION);
    }
    console.error(pc.red(message));
    process.exit(1);
  }

  const profileSkills = catalog.resolveProfile(profileName);
  if (profileSkills.length === 0) {
    const message = `Profile not found: ${profileName}`;
    if (format === 'json') {
      emitJsonError(
        operation,
        mvi,
        ErrorCodes.SKILL_NOT_FOUND,
        message,
        ErrorCategories.NOT_FOUND,
        {
          availableProfiles: catalog.listProfiles(),
        },
      );
    }
    console.error(pc.red(message));
    const available = catalog.listProfiles();
    if (available.length > 0) {
      console.log(pc.dim('Available profiles: ' + available.join(', ')));
    }
    process.exit(1);
  }

  if (format === 'human') {
    console.log(`Installing profile ${pc.bold(profileName)} (${profileSkills.length} skill(s))...`);
    console.log(pc.dim(`Target: ${providers.length} provider(s)`));
  }

  const installed: InstallResultItem[] = [];
  const failed: FailedResultItem[] = [];

  for (const name of profileSkills) {
    const skillDir = catalog.getSkillDir(name);
    try {
      const result = await dispatchInstallSkillAcrossProviders(skillDir, name, providers, isGlobal);

      if (result.success) {
        if (format === 'human') {
          console.log(pc.green(`  + ${name}`));
        }
        await recordSkillInstall(
          name,
          `library:${name}`,
          `library:${name}`,
          'library',
          result.linkedAgents,
          result.canonicalPath,
          true,
        );
        installed.push({
          name,
          scopedName: `library:${name}`,
          canonicalPath: result.canonicalPath,
          providers: result.linkedAgents,
        });
      } else {
        if (format === 'human') {
          console.log(pc.yellow(`  ! ${name}: ${result.errors.join(', ')}`));
        }
        failed.push({
          name,
          error: result.errors.join(', '),
        });
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      if (format === 'human') {
        console.log(pc.red(`  x ${name}: ${errorMsg}`));
      }
      failed.push({
        name,
        error: errorMsg,
      });
    }
  }

  const summary: InstallSummary = {
    installed,
    failed,
    count: {
      installed: installed.length,
      failed: failed.length,
      total: profileSkills.length,
    },
  };

  if (format === 'json') {
    if (failed.length > 0) {
      const envelope = buildEnvelope(operation, mvi, summary, {
        code: ErrorCodes.INSTALL_FAILED,
        message: `${failed.length} skill(s) failed to install`,
        category: ErrorCategories.INTERNAL,
        retryable: false,
        retryAfterMs: null,
        details: { failed: failed.map((f) => f.name) },
      });
      console.error(JSON.stringify(envelope, null, 2));
      process.exit(1);
    } else {
      outputSuccess(operation, mvi, summary);
    }
  } else {
    console.log(
      `\n${pc.green(`${installed.length} installed`)}, ${failed.length > 0 ? pc.yellow(`${failed.length} failed`) : '0 failed'}`,
    );
    if (failed.length > 0) {
      process.exit(1);
    }
  }
}

interface MarketplaceSourceSuccess {
  success: true;
  localPath: string;
  cleanup: () => Promise<void>;
  skillName: string;
  sourceValue: string;
  sourceType: SourceType;
}

interface MarketplaceSourceError {
  success: false;
}

type MarketplaceSourceResult = MarketplaceSourceSuccess | MarketplaceSourceError;

async function handleMarketplaceSource(
  source: string,
  _providers: Provider[],
  _isGlobal: boolean,
  format: 'json' | 'human',
  operation: string,
  mvi: MVILevel,
): Promise<MarketplaceSourceResult> {
  if (format === 'human') {
    console.log(pc.dim(`Searching marketplace for ${source}...`));
  }

  const client = new MarketplaceClient();
  let skill: import('../../core/marketplace/types.js').MarketplaceResult | null;

  try {
    skill = await client.getSkill(source);
  } catch (error) {
    const message = `Marketplace lookup failed: ${formatNetworkError(error)}`;
    if (format === 'json') {
      emitJsonError(operation, mvi, ErrorCodes.NETWORK_ERROR, message, ErrorCategories.TRANSIENT);
    }
    console.error(pc.red(message));
    return { success: false };
  }

  if (!skill) {
    const message = `Skill not found: ${source}`;
    if (format === 'json') {
      emitJsonError(operation, mvi, ErrorCodes.SKILL_NOT_FOUND, message, ErrorCategories.NOT_FOUND);
    }
    console.error(pc.red(message));
    return { success: false };
  }

  if (format === 'human') {
    console.log(
      `  Found: ${pc.bold(skill.name)} by ${skill.author} (${pc.dim(skill.repoFullName)})`,
    );
  }

  const parsed = parseSource(skill.githubUrl);
  if (parsed.type !== 'github' || !parsed.owner || !parsed.repo) {
    const message = 'Could not resolve GitHub source';
    if (format === 'json') {
      emitJsonError(operation, mvi, ErrorCodes.INVALID_FORMAT, message, ErrorCategories.VALIDATION);
    }
    console.error(pc.red(message));
    return { success: false };
  }

  try {
    const subPathCandidates = buildSkillSubPathCandidates(skill.path, parsed.path);
    let cloneError: unknown;
    let cloned = false;
    let localPath: string | undefined;
    let cleanup: (() => Promise<void>) | undefined;

    for (const subPath of subPathCandidates) {
      try {
        const result = await cloneRepo(parsed.owner, parsed.repo, parsed.ref, subPath);
        if (subPath && !existsSync(result.localPath)) {
          await result.cleanup();
          continue;
        }
        localPath = result.localPath;
        cleanup = result.cleanup;
        cloned = true;
        break;
      } catch (error) {
        cloneError = error;
      }
    }

    if (!cloned) {
      throw cloneError ?? new Error('Unable to resolve skill path from marketplace metadata');
    }

    return {
      success: true,
      localPath: localPath!,
      cleanup: cleanup!,
      skillName: skill.name,
      sourceValue: skill.githubUrl,
      sourceType: parsed.type,
    };
  } catch (error) {
    const message = `Failed to fetch source repository: ${formatNetworkError(error)}`;
    if (format === 'json') {
      emitJsonError(operation, mvi, ErrorCodes.NETWORK_ERROR, message, ErrorCategories.TRANSIENT);
    }
    console.error(pc.red(message));
    return { success: false };
  }
}
