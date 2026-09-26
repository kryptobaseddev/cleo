/**
 * Gated skill install pipeline — the one library entry point every skill
 * install goes through, from `caamp skills install` and from `cleo tools skill
 * install` alike.
 *
 * Before T12384 the pipeline (resolve → fetch → security gate → copy → link →
 * record) lived inside the Commander action in `commands/skills/install.ts`,
 * where CLEO could not reach it. CLEO therefore called the bare `installSkill`
 * primitive, which has no gate, and passed it the literal string
 * `library:<name>` as a filesystem path (T12383). The caamp copy of the gate
 * also failed OPEN: when `@cleocode/core` could not be loaded it logged a
 * warning and installed anyway.
 *
 * This module fixes all three:
 *
 * - {@link resolveSkillSource} turns any accepted source string — a registered
 *   library id (`library:<name>` or a bare name), a local path, a GitHub or
 *   GitLab repo/URL, a marketplace `@author/name` — into a real local
 *   directory, or throws. It never hands an identifier to the copier.
 * - {@link runSkillInstallGate} runs the federation checksum gate and the
 *   skills-guard scan and FAILS CLOSED: if the gate's modules cannot be loaded,
 *   the install is refused.
 * - {@link installSkillFromSource} / {@link installResolvedSkill} are the only
 *   functions that should place a skill. Both gate before any filesystem
 *   write, and the underlying copier stages the new copy before replacing the
 *   old one.
 *
 * @task T12383
 * @task T12384
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  SkillGateFederationInput,
  SkillGateFederationResult,
  SkillGatePolicyDecision,
  SkillGateScanResult,
} from '@cleocode/contracts';
import { pushWarning } from '@cleocode/lafs';
import type { Provider, SourceType } from '../../types.js';
import { dispatchInstallSkillAcrossProviders } from '../harness/index.js';
import { ErrorCodes } from '../lafs.js';
import { MarketplaceClient } from '../marketplace/client.js';
import { formatNetworkError } from '../network/fetch.js';
import { buildSkillSubPathCandidates } from '../paths/standard.js';
import { cloneRepo } from '../sources/github.js';
import { cloneGitLabRepo } from '../sources/gitlab.js';
import { isMarketplaceScoped, parseSource } from '../sources/parser.js';
import * as catalog from './catalog.js';
import { discoverSkill } from './discovery.js';
import type { InstallSkillOptions, SkillInstallResult } from './installer.js';
import { recordSkillInstall } from './lock.js';

// ── Errors ──────────────────────────────────────────────────────────

/**
 * Error codes raised by the gated install pipeline.
 *
 * @remarks
 * Values are drawn from caamp's LAFS {@link ErrorCodes} table so CLI envelopes
 * and library callers report the same code for the same refusal.
 *
 * @public
 */
export type SkillInstallErrorCode =
  | typeof ErrorCodes.SKILL_NOT_FOUND
  | typeof ErrorCodes.INVALID_INPUT
  | typeof ErrorCodes.INVALID_FORMAT
  | typeof ErrorCodes.NETWORK_ERROR
  | typeof ErrorCodes.SKILL_TRUST_GATE_BLOCKED
  | typeof ErrorCodes.SKILL_GATE_UNAVAILABLE
  | typeof ErrorCodes.FEDERATION_CHECKSUM_MISMATCH
  | typeof ErrorCodes.FEDERATION_UNKNOWN_SOURCE_INTERACTIVE_REQUIRED;

/**
 * Structured detail attached to a {@link SkillInstallError}.
 *
 * @public
 */
export interface SkillInstallErrorDetails {
  /** Scan result when the refusal came from the skills-guard scan. */
  scan?: SkillGateScanResult;
  /** Federation gate result when the refusal came from the checksum/source gate. */
  federation?: SkillGateFederationResult;
  /** Skill names the registered library does offer, when a lookup missed. */
  availableSkills?: string[];
  /** Underlying error message, when the refusal wraps another failure. */
  cause?: string;
}

/**
 * A skill install that was refused before anything was written.
 *
 * @remarks
 * Every refusal from this module is thrown as this type, so callers can map
 * `code` to an envelope and trust that the installed copy was not touched.
 *
 * @example
 * ```typescript
 * try {
 *   await installSkillFromSource("owner/repo", { providers, isGlobal: true });
 * } catch (err) {
 *   if (err instanceof SkillInstallError) console.error(err.code, err.message);
 * }
 * ```
 *
 * @public
 */
export class SkillInstallError extends Error {
  /** Machine-readable refusal code. */
  readonly code: SkillInstallErrorCode;
  /** Structured context for the refusal. */
  readonly details: SkillInstallErrorDetails;

  /**
   * @param code - Refusal code
   * @param message - Human-readable reason
   * @param details - Structured context
   */
  constructor(
    code: SkillInstallErrorCode,
    message: string,
    details: SkillInstallErrorDetails = {},
  ) {
    super(message);
    this.name = 'SkillInstallError';
    this.code = code;
    this.details = details;
  }
}

// ── Source resolution ───────────────────────────────────────────────

/**
 * A skill source resolved to a real local directory.
 *
 * @public
 */
export interface ResolvedSkillSource {
  /** Absolute path of the directory to install from. */
  localPath: string;
  /** Name the skill is installed under. */
  skillName: string;
  /** Provenance string recorded for the install (e.g. `library:ct-foo`, a GitHub URL). */
  sourceValue: string;
  /** Classified source type. */
  sourceType: SourceType;
  /** Removes any temporary checkout; absent for sources that live on disk already. */
  cleanup?: () => Promise<void>;
}

/**
 * A resolution step worth telling a human about.
 *
 * @remarks
 * The library does not print; a CLI renders these (e.g. in `--human` mode).
 *
 * @public
 */
export type SkillSourceProgress =
  | { readonly kind: 'marketplace-search'; readonly source: string }
  | {
      readonly kind: 'marketplace-found';
      readonly name: string;
      readonly author: string;
      readonly repo: string;
    }
  | {
      readonly kind: 'catalog-found';
      readonly name: string;
      readonly version: string;
      readonly category: string;
    };

/** Receives {@link SkillSourceProgress} events during resolution. */
type ProgressSink = ((event: SkillSourceProgress) => void) | undefined;

/** Look a skill name up in the registered catalog. */
function resolveFromCatalog(name: string, onProgress: ProgressSink): ResolvedSkillSource {
  if (!catalog.isCatalogAvailable()) {
    throw new SkillInstallError(
      ErrorCodes.INVALID_INPUT,
      'No skill library registered. Register one with registerSkillLibraryFromPath() or set CAAMP_SKILL_LIBRARY env var.',
    );
  }
  const entry = catalog.getSkill(name);
  if (!entry) {
    throw new SkillInstallError(ErrorCodes.SKILL_NOT_FOUND, `Skill not found in catalog: ${name}`, {
      availableSkills: catalog.listSkills(),
    });
  }
  onProgress?.({
    kind: 'catalog-found',
    name: entry.name,
    version: entry.version,
    category: entry.category,
  });
  return {
    localPath: catalog.getSkillDir(entry.name),
    skillName: entry.name,
    sourceValue: `library:${entry.name}`,
    sourceType: 'library',
  };
}

/** Clone a GitHub or GitLab source, mapping clone failures to a typed refusal. */
async function cloneSource(
  kind: 'github' | 'gitlab',
  owner: string,
  repo: string,
  ref: string | undefined,
  path: string | undefined,
): Promise<{ localPath: string; cleanup: () => Promise<void> }> {
  try {
    return kind === 'github'
      ? await cloneRepo(owner, repo, ref, path)
      : await cloneGitLabRepo(owner, repo, ref, path);
  } catch (error) {
    const host = kind === 'github' ? 'GitHub' : 'GitLab';
    throw new SkillInstallError(
      ErrorCodes.NETWORK_ERROR,
      `Failed to clone ${host} repository: ${formatNetworkError(error)}`,
    );
  }
}

/** Resolve a marketplace `@author/name` id to a cloned checkout of its skill directory. */
async function resolveFromMarketplace(
  source: string,
  onProgress: ProgressSink,
): Promise<ResolvedSkillSource> {
  onProgress?.({ kind: 'marketplace-search', source });
  let skill: Awaited<ReturnType<MarketplaceClient['getSkill']>>;
  try {
    skill = await new MarketplaceClient().getSkill(source);
  } catch (error) {
    throw new SkillInstallError(
      ErrorCodes.NETWORK_ERROR,
      `Marketplace lookup failed: ${formatNetworkError(error)}`,
    );
  }
  if (!skill) {
    throw new SkillInstallError(ErrorCodes.SKILL_NOT_FOUND, `Skill not found: ${source}`);
  }
  onProgress?.({
    kind: 'marketplace-found',
    name: skill.name,
    author: skill.author,
    repo: skill.repoFullName,
  });

  const parsed = parseSource(skill.githubUrl);
  if (parsed.type !== 'github' || !parsed.owner || !parsed.repo) {
    throw new SkillInstallError(ErrorCodes.INVALID_FORMAT, 'Could not resolve GitHub source');
  }

  let lastError: string | undefined;
  for (const subPath of buildSkillSubPathCandidates(skill.path, parsed.path)) {
    try {
      const cloned = await cloneRepo(parsed.owner, parsed.repo, parsed.ref, subPath);
      if (subPath && !existsSync(cloned.localPath)) {
        await cloned.cleanup();
        continue;
      }
      return {
        localPath: cloned.localPath,
        cleanup: cloned.cleanup,
        skillName: skill.name,
        sourceValue: skill.githubUrl,
        sourceType: 'github',
      };
    } catch (error) {
      lastError = formatNetworkError(error);
    }
  }
  throw new SkillInstallError(
    ErrorCodes.NETWORK_ERROR,
    `Failed to fetch source repository: ${lastError ?? 'Unable to resolve skill path from marketplace metadata'}`,
  );
}

/**
 * Resolve a skill source string to a real local directory.
 *
 * @remarks
 * Accepted forms:
 *
 * - `library:<name>` (or `<package>:<name>`) and bare `<name>` — looked up in
 *   the registered skill library ({@link catalog}).
 * - An absolute, `./`, `../` or `~` path — used as is (the name comes from its
 *   `SKILL.md` when present).
 * - `owner/repo[/path]`, a GitHub URL or a GitLab URL — cloned to a temporary
 *   directory; call `cleanup` when done.
 * - `@author/name` — looked up in the skill marketplace, then cloned.
 *
 * Anything else is refused. An identifier is never returned as `localPath`,
 * which is the T12383 defect: `library:<name>` used to reach `cp()` verbatim.
 *
 * @param source - Source string as typed by the user or stored in a lock row
 * @param onProgress - Optional sink for human-facing resolution events
 * @returns The resolved local source
 * @throws {@link SkillInstallError} when the source cannot be resolved
 *
 * @example
 * ```typescript
 * const resolved = await resolveSkillSource("library:ct-cleo");
 * try {
 *   console.log(resolved.localPath);
 * } finally {
 *   await resolved.cleanup?.();
 * }
 * ```
 *
 * @public
 */
export async function resolveSkillSource(
  source: string,
  onProgress?: (event: SkillSourceProgress) => void,
): Promise<ResolvedSkillSource> {
  if (isMarketplaceScoped(source)) return resolveFromMarketplace(source, onProgress);

  const parsed = parseSource(source);
  switch (parsed.type) {
    case 'library':
      return resolveFromCatalog(parsed.inferredName, onProgress);
    case 'package':
      // A bare name. `inferredName` strips MCP-package affixes, which are not
      // part of a skill name, so look up the value as typed.
      return resolveFromCatalog(parsed.value, onProgress);
    case 'local': {
      const localPath = parsed.value.startsWith('~')
        ? join(homedir(), parsed.value.slice(1))
        : parsed.value;
      const discovered = await discoverSkill(localPath);
      return {
        localPath,
        skillName: discovered?.name ?? parsed.inferredName,
        sourceValue: parsed.value,
        sourceType: 'local',
      };
    }
    case 'github':
    case 'gitlab': {
      if (!parsed.owner || !parsed.repo) break;
      const cloned = await cloneSource(
        parsed.type,
        parsed.owner,
        parsed.repo,
        parsed.ref,
        parsed.path,
      );
      return {
        localPath: cloned.localPath,
        cleanup: cloned.cleanup,
        skillName: parsed.inferredName,
        sourceValue: parsed.value,
        sourceType: parsed.type,
      };
    }
    default:
      break;
  }
  throw new SkillInstallError(
    ErrorCodes.INVALID_FORMAT,
    `Unsupported skill source: ${source} (type ${parsed.type})`,
  );
}

// ── Security gate ───────────────────────────────────────────────────

/**
 * The `@cleocode/core` functions the gate calls.
 *
 * @remarks
 * Loaded lazily because core depends on caamp at build time; a static import
 * of these modules would put core's whole skills graph on caamp's startup
 * path. Typed against the shared `@cleocode/contracts` gate shapes, which
 * mirror core's types structurally, so core's functions are assignable here.
 *
 * @public
 */
export interface SkillGateModules {
  /** Skills-guard static scan. */
  scanSkill: (skillPath: string, source: string) => SkillGateScanResult;
  /** INSTALL_POLICY decision over a scan result. */
  shouldAllowInstall: (result: SkillGateScanResult, force: boolean) => SkillGatePolicyDecision;
  /** Federation first-install and checksum gate. */
  evaluateFederationInstallGate: (opts: SkillGateFederationInput) => SkillGateFederationResult;
  /** Audit writer for operator `force` bypasses. */
  recordTrustBypass: (result: SkillGateScanResult, reason: string | null) => object;
}

/** Loads the gate's core modules. Replaceable in tests via {@link __installPipelineTesting}. */
type SkillGateLoader = () => Promise<SkillGateModules>;

const defaultGateLoader: SkillGateLoader = async () => {
  const [guard, federation, audit] = await Promise.all([
    import('@cleocode/core/skills/skills-guard.js'),
    import('@cleocode/core/skills/federation-install-gate.js'),
    import('@cleocode/core/skills/skills-guard-audit.js'),
  ]);
  return {
    scanSkill: guard.scanSkill,
    shouldAllowInstall: guard.shouldAllowInstall,
    evaluateFederationInstallGate: federation.evaluateFederationInstallGate,
    recordTrustBypass: audit.recordTrustBypass,
  };
};

let gateLoader: SkillGateLoader = defaultGateLoader;

/**
 * Options for {@link runSkillInstallGate}.
 *
 * @public
 */
export interface SkillInstallGateOptions {
  /** Operator override of a `block` scan decision (audited). Never overrides `ask` or a checksum mismatch. */
  force?: boolean;
  /** Approve a first install from an unverified federation source (non-interactive contexts). */
  allowNewSource?: boolean;
  /** Checksum the artefact must match, when the source declares one. */
  expectedChecksum?: string | null;
}

/**
 * What the gate decided, for callers that report it.
 *
 * @public
 */
export interface SkillInstallGateReport {
  /** The skills-guard scan of the staged source. */
  scan: SkillGateScanResult;
  /** The install-policy decision (always `allow` when this returns). */
  decision: SkillGatePolicyDecision;
  /** The federation gate result (always `allow` when this returns). */
  federation: SkillGateFederationResult;
  /** Whether an operator `force` bypass was used and audited. */
  bypassed: boolean;
}

/**
 * Trust identity the scanner sees for a source.
 *
 * @remarks
 * Skills from the registered CLEO library ship with CLEO, so they scan as
 * `official` (the `builtin` tier). Every other source is scanned under its own
 * identifier, which resolves to `trusted` only for the allow-listed repos.
 */
function scanIdentity(source: ResolvedSkillSource): string {
  return source.sourceType === 'library' ? `official/${source.skillName}` : source.sourceValue;
}

/**
 * Run the federation checksum gate and the skills-guard scan over a resolved
 * source. Fails closed.
 *
 * @remarks
 * Order matters: the federation gate runs first, so a checksum mismatch or an
 * unapproved federation source is refused before the scanner reads the bytes.
 * Both run before any filesystem write.
 *
 * Unlike the pre-T12384 caamp CLI gate, a failure to load the gate's modules is
 * a refusal (`E_SKILL_GATE_UNAVAILABLE`), not a skipped check.
 *
 * @param source - The resolved source to vet
 * @param options - Operator overrides
 * @returns The gate report when the install may proceed
 * @throws {@link SkillInstallError} when the install is refused or the gate is unavailable
 *
 * @example
 * ```typescript
 * const report = await runSkillInstallGate(resolved, { force: false });
 * console.log(report.scan.verdict);
 * ```
 *
 * @public
 */
export async function runSkillInstallGate(
  source: ResolvedSkillSource,
  options: SkillInstallGateOptions = {},
): Promise<SkillInstallGateReport> {
  let modules: SkillGateModules;
  try {
    modules = await gateLoader();
  } catch (error) {
    throw new SkillInstallError(
      ErrorCodes.SKILL_GATE_UNAVAILABLE,
      'Skill security gate unavailable (@cleocode/core skills modules could not be loaded); install refused.',
      { cause: error instanceof Error ? error.message : String(error) },
    );
  }

  const federation = modules.evaluateFederationInstallGate({
    source: source.sourceValue,
    artefactPath: source.localPath,
    expectedChecksum: options.expectedChecksum ?? null,
    approveNewSource: options.allowNewSource === true,
  });
  if (federation.decision === 'block-checksum') {
    throw new SkillInstallError(
      ErrorCodes.FEDERATION_CHECKSUM_MISMATCH,
      `Federation install blocked: ${federation.reason}`,
      { federation },
    );
  }
  if (federation.decision === 'prompt-first-install') {
    throw new SkillInstallError(
      ErrorCodes.FEDERATION_UNKNOWN_SOURCE_INTERACTIVE_REQUIRED,
      `${federation.reason} Use --allow-new-source to approve in non-interactive contexts.`,
      { federation },
    );
  }

  const scan = modules.scanSkill(source.localPath, scanIdentity(source));
  const decision = modules.shouldAllowInstall(scan, options.force === true);
  if (decision.decision === 'block') {
    throw new SkillInstallError(
      ErrorCodes.SKILL_TRUST_GATE_BLOCKED,
      `Trust gate blocked install: ${decision.reason}`,
      { scan },
    );
  }
  if (decision.decision === 'ask') {
    throw new SkillInstallError(
      ErrorCodes.SKILL_TRUST_GATE_BLOCKED,
      `Trust gate requires confirmation: ${decision.reason}`,
      { scan },
    );
  }

  const bypassed = options.force === true && scan.verdict !== 'safe';
  if (bypassed) {
    try {
      modules.recordTrustBypass(scan, 'operator force on skill install');
    } catch (err) {
      // The operator already authorised the bypass; an audit-log write failure
      // is surfaced through the LAFS collector rather than stderr (T9770).
      pushWarning({
        code: 'W_AUDIT_LOG_FAILED',
        severity: 'warn',
        message: 'trust-bypass audit record failed',
        context: { error: err instanceof Error ? err.message : String(err) },
      });
    }
  }
  return { scan, decision, federation, bypassed };
}

// ── Install ─────────────────────────────────────────────────────────

/**
 * Options for {@link installSkillFromSource} and {@link installResolvedSkill}.
 *
 * @public
 */
export interface GatedSkillInstallOptions extends SkillInstallGateOptions {
  /** Providers to link the skill into. */
  providers: Provider[];
  /** Global (`true`) or project scope. */
  isGlobal: boolean;
  /** Project directory for project scope. */
  projectDir?: string;
  /** Provenance sink forwarded to the canonical installer. */
  recordRow?: InstallSkillOptions['recordRow'];
  /** Record the install in the CAAMP lock file. @defaultValue false */
  recordLock?: boolean;
  /** Override the name the skill installs under. */
  skillName?: string;
  /** Sink for human-facing resolution events (used by {@link installSkillFromSource}). */
  onProgress?: (event: SkillSourceProgress) => void;
}

/**
 * Result of a gated install.
 *
 * @public
 */
export interface GatedSkillInstallResult extends SkillInstallResult {
  /** Provenance string recorded for the install. */
  sourceValue: string;
  /** Classified source type. */
  sourceType: SourceType;
  /** The gate's report. */
  gate: SkillInstallGateReport;
}

/**
 * Gate and install an already-resolved source.
 *
 * @remarks
 * Use this when the caller has a checkout in hand (for example an update that
 * cloned the source itself). The gate runs first; on refusal nothing is
 * written. The canonical copy is staged before it replaces the installed one
 * (T12383), so a failure part-way through keeps the installed skill.
 *
 * Does not call `source.cleanup` — the caller owns the checkout.
 *
 * @param source - Resolved source
 * @param options - Targets, scope, provenance and gate overrides
 * @returns The install result, including the gate report
 * @throws {@link SkillInstallError} when the gate refuses the install
 *
 * @example
 * ```typescript
 * const result = await installResolvedSkill(
 *   { localPath: "/tmp/co/skill", skillName: "demo", sourceValue: "owner/repo", sourceType: "github" },
 *   { providers, isGlobal: true },
 * );
 * ```
 *
 * @public
 */
export async function installResolvedSkill(
  source: ResolvedSkillSource,
  options: GatedSkillInstallOptions,
): Promise<GatedSkillInstallResult> {
  const skillName = options.skillName ?? source.skillName;
  const gate = await runSkillInstallGate({ ...source, skillName }, options);

  // Provenance options only matter to a `recordRow` sink; omit them otherwise
  // so the dispatcher keeps its legacy argument shape.
  const result = options.recordRow
    ? await dispatchInstallSkillAcrossProviders(
        source.localPath,
        skillName,
        options.providers,
        options.isGlobal,
        options.projectDir,
        {
          recordRow: options.recordRow,
          sourceUrl: source.sourceValue,
          sourceType: source.sourceType === 'library' ? 'canonical' : undefined,
        },
      )
    : await dispatchInstallSkillAcrossProviders(
        source.localPath,
        skillName,
        options.providers,
        options.isGlobal,
        options.projectDir,
      );

  if (result.success && options.recordLock === true) {
    const lockIsGlobal = source.sourceType === 'library' ? true : options.isGlobal;
    const lockArgs = [
      skillName,
      source.sourceValue,
      source.sourceValue,
      source.sourceType,
      result.linkedAgents,
      result.canonicalPath,
      lockIsGlobal,
    ] as const;
    if (!lockIsGlobal && options.projectDir !== undefined) {
      await recordSkillInstall(...lockArgs, options.projectDir);
    } else {
      await recordSkillInstall(...lockArgs);
    }
  }

  return { ...result, sourceValue: source.sourceValue, sourceType: source.sourceType, gate };
}

/**
 * Resolve, gate and install a skill from any accepted source string.
 *
 * @remarks
 * The single entry point for installing a skill (T12384). Resolution turns the
 * source into a real directory ({@link resolveSkillSource}); the gate vets it
 * and fails closed ({@link runSkillInstallGate}); the installer stages the new
 * copy before replacing the old one. Temporary checkouts are always removed.
 *
 * @param source - `library:<name>`, a bare library name, a local path,
 *   `owner/repo`, a GitHub/GitLab URL, or `@author/name`
 * @param options - Targets, scope, provenance and gate overrides
 * @returns The install result, including the gate report
 * @throws {@link SkillInstallError} when the source cannot be resolved or the gate refuses it
 *
 * @example
 * ```typescript
 * const result = await installSkillFromSource("library:ct-cleo", {
 *   providers: getInstalledProviders(),
 *   isGlobal: true,
 * });
 * console.log(result.linkedAgents);
 * ```
 *
 * @public
 */
export async function installSkillFromSource(
  source: string,
  options: GatedSkillInstallOptions,
): Promise<GatedSkillInstallResult> {
  const resolved = await resolveSkillSource(source, options.onProgress);
  try {
    return await installResolvedSkill(resolved, options);
  } finally {
    await resolved.cleanup?.();
  }
}

/**
 * Test seams for the install pipeline.
 *
 * @internal
 */
export const __installPipelineTesting = {
  /** Replace the gate-module loader; pass `null` to restore the default. */
  setGateLoader(loader: SkillGateLoader | null): void {
    gateLoader = loader ?? defaultGateLoader;
  },
};
