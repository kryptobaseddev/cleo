/**
 * Canonical release pipeline (T1597 / ADR-063).
 *
 * Standardizes the release flow across every CLEO-managed project as a
 * deterministic 4-step sequence:
 *
 *   1. {@link releaseStart}     — validate version, capture branch, persist handle
 *   2. {@link releaseVerify}    — run quality gates + check release epic children
 *   3. {@link releasePublish}   — invoke project-specific publish command
 *   4. {@link releaseReconcile} — run post-release invariants, auto-complete tasks
 *
 * The pipeline is **project-agnostic**:
 *
 *   - Version validation reads `version.scheme` from
 *     `.cleo/project-context.json` (calver / semver / sha / auto).
 *   - Publish reads `publish.command` from project-context (npm publish,
 *     cargo publish, twine upload, go releaser, …).
 *   - Quality gate tools resolve via the existing ADR-061 alias map
 *     (`tool:test`, `tool:lint`, `tool:typecheck`, `tool:audit`,
 *     `tool:security-scan`).
 *   - Release branch resolves from `git rev-parse --abbrev-ref HEAD`,
 *     never hard-coded to `main`.
 *
 * The handle returned by {@link releaseStart} is persisted under
 * `.cleo/release/handle.json` so subsequent steps can resume without
 * re-passing `--version`.
 *
 * @task T1597
 * @adr ADR-063
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type {
  PublishResult,
  ReleaseGateStatus,
  ReleaseHandle,
  ReleaseReconcileResult,
  ReleaseVersionScheme,
  VerifyResult,
} from '@cleocode/contracts';
import { loadProjectContext } from '../agents/variable-substitution.js';
import { getProjectRoot } from '../paths.js';
import { runToolCached } from '../tasks/tool-cache.js';
import { resolveToolCommand } from '../tasks/tool-resolver.js';
import { runInvariants } from './invariants/index.js';
import { isCalVer, validateVersionFormat } from './version-bump.js';

const execFileAsync = promisify(execFile);

/** Options for {@link releaseStart}. */
export interface ReleaseStartOptions {
  /** Override branch detection (defaults to `git rev-parse --abbrev-ref HEAD`). */
  branch?: string;
  /** Optional epic ID this release ships. Used by {@link releaseReconcile}. */
  epicId?: string;
  /** Project root (defaults to `process.cwd()`). */
  projectRoot?: string;
}

/** Options for {@link releaseVerify}. */
export interface ReleaseVerifyOptions {
  /** Skip the child-task gate audit (e.g. for ad-hoc patch releases). */
  skipChildAudit?: boolean;
  /**
   * Gate executor — REQUIRED. Callers MUST supply a real runner (see
   * {@link makeAdr061GateRunner}) or a test double. The pipeline no longer
   * provides a default because the former default always returned
   * `passed: false` without executing anything, producing silent theater.
   *
   * @required
   */
  runGate: (canonicalTool: string, cwd: string) => Promise<{ passed: boolean; reason?: string }>;
  /** Override the child-task auditor — primarily for testing. */
  auditChildren?: (
    epicId: string,
    cwd: string,
  ) => Promise<{
    examined: number;
    ungreen: Array<{ taskId: string; missingGates: string[] }>;
  }>;
}

/** Options for {@link releasePublish}. */
export interface ReleasePublishOptions {
  /** Print the command instead of executing (no remote mutation). */
  dryRun?: boolean;
  /** Override the resolved command (caller-supplied — e.g. owner override). */
  commandOverride?: string;
}

/** Options for {@link releaseReconcile}. */
export interface ReleaseReconcileOptions {
  /** Forward to the underlying invariant runner. */
  dryRun?: boolean;
}

/** Where the active release handle is persisted. */
const HANDLE_RELATIVE_PATH = '.cleo/release/handle.json';

/** Canonical gates checked by {@link releaseVerify}. */
const VERIFY_GATES: ReadonlyArray<'test' | 'lint' | 'typecheck' | 'audit' | 'security-scan'> = [
  'test',
  'lint',
  'typecheck',
  'audit',
  'security-scan',
];

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Read `publish.command` (and friends) from project-context. */
interface ResolvedPublishConfig {
  command: string;
  scheme: ReleaseVersionScheme;
}

/**
 * Resolve publish + version-scheme settings from `.cleo/project-context.json`,
 * with sensible per-`primaryType` fallbacks.
 *
 * Read order:
 *   1. `publish.command` / `version.scheme` (explicit project setting)
 *   2. `primaryType` fallback (node → npm publish, rust → cargo publish, …)
 *   3. Final fallback: `npm publish`, scheme `auto`.
 */
function resolveProjectConfig(projectRoot: string): ResolvedPublishConfig {
  const ctxResult = loadProjectContext(projectRoot);
  const ctx = ctxResult.context ?? {};

  const publishSection = isPlainObject(ctx.publish) ? ctx.publish : undefined;
  const versionSection = isPlainObject(ctx.version) ? ctx.version : undefined;
  const primaryType = typeof ctx.primaryType === 'string' ? ctx.primaryType : 'node';

  const explicitCommand =
    publishSection && typeof publishSection.command === 'string'
      ? publishSection.command
      : undefined;

  const explicitScheme =
    versionSection && typeof versionSection.scheme === 'string'
      ? (versionSection.scheme as ReleaseVersionScheme)
      : undefined;

  return {
    command: explicitCommand ?? defaultPublishCommandFor(primaryType),
    scheme: explicitScheme ?? 'auto',
  };
}

/** Default publish command per project type. */
function defaultPublishCommandFor(primaryType: string): string {
  switch (primaryType) {
    case 'rust':
      return 'cargo publish';
    case 'python':
      return 'twine upload dist/*';
    case 'go':
      return 'goreleaser release';
    case 'ruby':
      return 'gem push';
    default:
      return 'npm publish';
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Validate a version string against the active scheme. */
function validateVersion(
  version: string,
  scheme: ReleaseVersionScheme,
): { ok: true } | { ok: false; reason: string } {
  // Strip any leading "v" prefix — tag prefix is independent of scheme.
  const normalized = version.startsWith('v') ? version.slice(1) : version;

  switch (scheme) {
    case 'calver':
      if (!isCalVer(normalized)) {
        return { ok: false, reason: `version "${version}" does not match CalVer (YYYY.M.P)` };
      }
      return { ok: true };
    case 'semver':
      if (!validateVersionFormat(normalized) || isCalVer(normalized)) {
        return { ok: false, reason: `version "${version}" does not match SemVer (X.Y.Z)` };
      }
      return { ok: true };
    case 'sha':
      if (!/^[a-f0-9]{7,40}$/i.test(normalized)) {
        return { ok: false, reason: `version "${version}" does not look like a git SHA` };
      }
      return { ok: true };
    case 'auto':
      if (!validateVersionFormat(normalized)) {
        return { ok: false, reason: `version "${version}" does not match CalVer or SemVer` };
      }
      return { ok: true };
    default:
      return { ok: false, reason: `unknown version scheme "${scheme}"` };
  }
}

/** Detect current git branch (no hard-coded "main"). */
async function detectBranch(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
    return stdout.trim() || 'HEAD';
  } catch {
    return 'HEAD';
  }
}

/** Persist a handle to `.cleo/release/handle.json`. */
function writeHandle(handle: ReleaseHandle): void {
  const path = join(handle.projectRoot, HANDLE_RELATIVE_PATH);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(handle, null, 2), 'utf-8');
}

/**
 * Read the persisted release handle for {@link releaseVerify} / publish /
 * reconcile callers that didn't pass the handle explicitly.
 *
 * @throws if no handle exists — pipeline must be started first.
 */
export function loadActiveReleaseHandle(projectRoot: string): ReleaseHandle {
  const path = join(projectRoot, HANDLE_RELATIVE_PATH);
  if (!existsSync(path)) {
    throw new Error(
      `No active release. Run \`cleo release start <version>\` first (expected ${path}).`,
    );
  }
  const raw = readFileSync(path, 'utf-8');
  return JSON.parse(raw) as ReleaseHandle;
}

/** Clear the persisted handle (called on successful reconcile). */
function clearHandle(projectRoot: string): void {
  const path = join(projectRoot, HANDLE_RELATIVE_PATH);
  if (existsSync(path)) {
    rmSync(path, { force: true });
  }
}

/**
 * Build an ADR-061-based gate runner for use in {@link releaseVerify}.
 *
 * Each gate is run by resolving the canonical tool name via
 * {@link resolveToolCommand} (which reads `.cleo/project-context.json` and
 * falls back to per-`primaryType` language defaults), then executing the
 * resolved command via {@link runToolCached} (which is cache-aware and
 * semaphore-bounded per ADR-061).
 *
 * Exit code 0 → `passed: true`. Non-zero exit or spawn error → `passed: false`
 * with captured stderr in `reason`.
 *
 * @param projectRoot - Absolute path to the project root (used for context
 *   resolution and tool execution cwd).
 * @returns A gate-runner function compatible with {@link ReleaseVerifyOptions.runGate}.
 *
 * @example
 * ```ts
 * const result = await releaseVerify(handle, {
 *   runGate: makeAdr061GateRunner(handle.projectRoot),
 * });
 * ```
 *
 * @task T9503
 * @adr ADR-061
 */
export function makeAdr061GateRunner(
  projectRoot: string,
): (canonicalTool: string, cwd: string) => Promise<{ passed: boolean; reason?: string }> {
  return async (canonicalTool: string, cwd: string) => {
    // T9550: Caller-supplied `cwd` can be any path (project root, monorepo
    // subdir, worktree). Normalize via the canonical resolver per ADR-067:
    // `getProjectRoot()` walks up from the candidate, honors worktree
    // AsyncLocalStorage scope, CLEO_ROOT/CLEO_PROJECT_ROOT/CLEO_DIR env
    // overrides, and validates against `.cleo/project-info.json`. If `cwd`
    // is omitted, fall back to the factory-captured `projectRoot`. The
    // factory value is itself passed through `getProjectRoot()` so the
    // entire pipeline shares one canonical-root contract.
    const candidate = cwd && cwd.length > 0 ? cwd : projectRoot;
    const effectiveRoot = getProjectRoot(candidate);

    const resolution = resolveToolCommand(canonicalTool, effectiveRoot);
    if (!resolution.ok) {
      return {
        passed: false,
        reason: `gate "${canonicalTool}" could not be resolved: ${resolution.reason}`,
      };
    }

    const result = await runToolCached(resolution.command, effectiveRoot);

    if (result.exitCode === null) {
      return {
        passed: false,
        reason:
          `gate "${canonicalTool}" → ${resolution.command.cmd} ${resolution.command.args.join(' ')} ` +
          `could not be executed (binary missing or spawn error)`,
      };
    }

    if (result.exitCode !== 0) {
      const tail = `${result.stdoutTail}\n${result.stderrTail}`.trim().slice(0, 512);
      return {
        passed: false,
        reason:
          `gate "${canonicalTool}" exited with code ${result.exitCode}` +
          `${result.cacheHit ? ' (cached)' : ''}${tail ? `. Output tail: ${tail}` : ''}`,
      };
    }

    return { passed: true };
  };
}

/** Default child-task auditor — empty result. Real impl provided by CLI. */
async function defaultAuditChildren(): Promise<{
  examined: number;
  ungreen: Array<{ taskId: string; missingGates: string[] }>;
}> {
  return { examined: 0, ungreen: [] };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Step 1 — Begin a release.
 *
 * Validates the version against the project's version scheme, captures the
 * release branch, and persists a handle for the subsequent pipeline steps.
 * No git tags are created and no remote mutation occurs here.
 *
 * @param version - Version string to release (with or without "v" prefix).
 * @param opts    - Optional branch/epic overrides.
 * @returns The persisted {@link ReleaseHandle}.
 * @throws If the version fails validation against the active scheme.
 */
export async function releaseStart(
  version: string,
  opts: ReleaseStartOptions = {},
): Promise<ReleaseHandle> {
  const projectRoot = opts.projectRoot ?? process.cwd();
  const { scheme } = resolveProjectConfig(projectRoot);

  const validation = validateVersion(version, scheme);
  if (!validation.ok) {
    throw new Error(`Invalid version: ${validation.reason}`);
  }

  const branch = opts.branch ?? (await detectBranch(projectRoot));
  const tag = version.startsWith('v') ? version : `v${version}`;
  const normalizedVersion = version.startsWith('v') ? version.slice(1) : version;

  const handle: ReleaseHandle = {
    version: normalizedVersion,
    tag,
    scheme,
    branch,
    startedAt: new Date().toISOString(),
    projectRoot,
    epicId: opts.epicId,
  };

  writeHandle(handle);
  return handle;
}

/**
 * Step 2 — Verify a release.
 *
 * Runs the canonical quality gates (test, lint, typecheck, audit,
 * security-scan) via the ADR-061 alias map and audits all child tasks of
 * the release epic for green gate state. Both must pass for `passed: true`.
 *
 * @param handle - From {@link releaseStart} or {@link loadActiveReleaseHandle}.
 * @param opts   - Optional gate-runner / child-auditor overrides (used by tests).
 */
export async function releaseVerify(
  handle: ReleaseHandle,
  opts: ReleaseVerifyOptions,
): Promise<VerifyResult> {
  const runGate = opts.runGate;
  const auditChildren = opts.auditChildren ?? defaultAuditChildren;

  const gates: ReleaseGateStatus[] = [];
  for (const gate of VERIFY_GATES) {
    const r = await runGate(gate, handle.projectRoot);
    gates.push({
      gate,
      passed: r.passed,
      tool: gate,
      ...(r.reason !== undefined ? { reason: r.reason } : {}),
    });
  }

  let ungreenChildren: VerifyResult['ungreenChildren'] = [];
  let childrenExamined = 0;

  if (!opts.skipChildAudit && handle.epicId) {
    const audit = await auditChildren(handle.epicId, handle.projectRoot);
    childrenExamined = audit.examined;
    ungreenChildren = audit.ungreen;
  }

  const allGatesGreen = gates.every((g) => g.passed);
  const allChildrenGreen = ungreenChildren.length === 0;

  return {
    passed: allGatesGreen && allChildrenGreen,
    gates,
    ungreenChildren,
    childrenExamined,
  };
}

/**
 * Step 3 — Publish a release.
 *
 * Invokes the resolved `publish.command` (e.g. `npm publish`,
 * `cargo publish`, `twine upload`) under the project root. The command is
 * resolved via {@link resolveProjectConfig} — never hard-coded.
 *
 * @param handle - From {@link releaseStart} or {@link loadActiveReleaseHandle}.
 * @param opts   - Dry-run / command override.
 */
export async function releasePublish(
  handle: ReleaseHandle,
  opts: ReleasePublishOptions = {},
): Promise<PublishResult> {
  const { command: resolved } = resolveProjectConfig(handle.projectRoot);
  const command = opts.commandOverride ?? resolved;
  const dryRun = opts.dryRun === true;

  if (dryRun) {
    return {
      success: true,
      command,
      output: `[DRY RUN] Would execute: ${command}`,
      dryRun: true,
    };
  }

  // Split on whitespace — sufficient for our canonical commands. Quoted
  // arguments would require a real parser, which we deliberately avoid to
  // keep this leaf module dependency-free.
  const parts = command.split(/\s+/).filter((p) => p.length > 0);
  const [cmd, ...args] = parts;
  if (!cmd) {
    return {
      success: false,
      command,
      output: `publish command resolved to empty string`,
      dryRun: false,
    };
  }

  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, { cwd: handle.projectRoot });
    return {
      success: true,
      command,
      output: `${stdout}\n${stderr}`.trim(),
      dryRun: false,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      command,
      output: message,
      dryRun: false,
    };
  }
}

/**
 * Step 4 — Reconcile a release.
 *
 * Delegates to the existing post-release invariants registry (T1411 /
 * ADR-056 D5), which auto-completes tasks referenced in the release commit
 * by stamping `archive_reason='verified'` and producing follow-ups for
 * unverified references.
 *
 * On success the persisted handle is cleared, ending the pipeline.
 */
export async function releaseReconcile(
  handle: ReleaseHandle,
  opts: ReleaseReconcileOptions = {},
): Promise<ReleaseReconcileResult> {
  const report = await runInvariants(handle.tag, {
    dryRun: opts.dryRun === true,
    cwd: handle.projectRoot,
  });

  const reconciledTasks: string[] = [];
  const unreconciledTasks: string[] = [];
  const errors: string[] = [];
  for (const r of report.results) {
    if (r.severity === 'error' || r.errors > 0) {
      errors.push(`${r.id}: ${r.message}`);
    }
    const details = r.details ?? {};
    if (Array.isArray(details.reconciled)) {
      for (const id of details.reconciled) {
        if (typeof id === 'string') reconciledTasks.push(id);
      }
    }
    if (Array.isArray(details.unreconciled)) {
      for (const id of details.unreconciled) {
        if (typeof id === 'string') unreconciledTasks.push(id);
      }
    }
  }

  const success = errors.length === 0 && report.errors === 0;

  if (success && !opts.dryRun) {
    clearHandle(handle.projectRoot);
  }

  return {
    success,
    tag: report.tag,
    reconciledTasks,
    unreconciledTasks,
    errors,
  };
}
