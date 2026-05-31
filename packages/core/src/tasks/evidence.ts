/**
 * Evidence-based gate validation (ADR-051 / T832).
 *
 * Parses and validates evidence atoms for `cleo verify`. Each atom is checked
 * against the filesystem, git, structured test-run JSON output (vitest /
 * pytest / cargo-nextest etc.), or a project-resolved toolchain exit code.
 * Soft evidence (`url:`, `note:`) is accepted without validation.
 *
 * Tool resolution is project-agnostic per T1534 / ADR-061:
 *   - {@link resolveToolCommand} maps `tool:<name>` to a runnable command
 *     using `.cleo/project-context.json` and per-`primaryType` fallbacks.
 *   - {@link runToolCached} memoises results per `(cmd, args, head, dirty)`
 *     and serialises concurrent identical runs via a cross-process lock,
 *     preventing the resource thrash observed when multiple `cleo verify`
 *     invocations spawned full toolchains in parallel.
 *
 * @task T832
 * @task T1534
 * @adr ADR-051
 * @adr ADR-061
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve as resolvePath } from 'node:path';

import type {
  EvidenceAtom,
  GateEvidence,
  EvidenceAtomInput as ParsedEvidenceAtom,
  VerificationGate,
} from '@cleocode/contracts';
import {
  EvidenceParseError,
  ExitCode,
  GATE_EVIDENCE_REQUIREMENTS,
  parseEvidenceString,
  validateEvidenceForGate,
} from '@cleocode/contracts';

import { CleoError } from '../errors.js';
import { getEffectiveHead } from '../worktree/effective-head.js';
import { runToolCached } from './tool-cache.js';
import {
  CANONICAL_TOOLS,
  type CanonicalTool,
  listValidToolNames,
  resolveToolCommand,
} from './tool-resolver.js';

/**
 * Valid tool names recognised by the `tool:<name>` evidence atom.
 *
 * Sourced from {@link listValidToolNames} so canonical names + every legacy
 * alias resolve identically. Use {@link isValidToolName} or pass to
 * {@link resolveToolCommand} directly — direct array indexing is no longer
 * the canonical path (post-T1534).
 *
 * @task T832
 * @task T1534
 */
export const VALID_TOOLS: readonly string[] = Object.freeze(listValidToolNames());

/**
 * Type of a supported evidence tool. Post-T1534, this is widened to every
 * canonical tool name plus every alias accepted by {@link resolveToolCommand}.
 *
 * Existing callers that assigned `'pnpm-test' | 'biome' | ...` continue to
 * compile because those literal types remain assignable to `string`.
 *
 * @task T832
 * @task T1534
 */
export type EvidenceTool = CanonicalTool | string;

/**
 * Test whether a string is a recognised tool name (canonical or alias).
 *
 * @task T1534
 */
export function isValidToolName(name: string): boolean {
  return VALID_TOOLS.includes(name);
}

/**
 * @deprecated Since T1534 — tool commands are resolved per-project from
 * `.cleo/project-context.json` via {@link resolveToolCommand}. This export
 * is retained as an empty record for back-compat with downstream callers
 * that destructured the legacy table; new code MUST call the resolver.
 *
 * @task T1534
 */
export const TOOL_COMMANDS: Record<string, { cmd: string; args: string[] }> = Object.freeze({});

/**
 * Minimum evidence required for each verification gate.
 *
 * - A single atom kind means at least one atom of that kind MUST be present.
 * - A tuple of kinds means all listed kinds MUST be present.
 * - Alternatives are modeled as separate sets — if ANY set is satisfied the
 *   evidence is accepted.
 *
 * **Source of truth (T10337):** the underlying spec now lives in
 * {@link GATE_EVIDENCE_REQUIREMENTS} in `@cleocode/contracts`. This export
 * is the legacy projection — `Record<gate, kind[][]>` — kept for back-
 * compat with consumers that hard-coded the nested-array shape. New code
 * SHOULD use {@link validateEvidenceForGate} from `@cleocode/contracts`
 * directly.
 *
 * @task T832
 * @task T1515
 * @task T10337
 * @adr ADR-051 §2.3
 */
export const GATE_EVIDENCE_MINIMUMS: Record<VerificationGate, EvidenceAtom['kind'][][]> =
  Object.freeze(
    Object.fromEntries(
      (
        Object.entries(GATE_EVIDENCE_REQUIREMENTS) as Array<
          [VerificationGate, { oneOf: ReadonlyArray<ReadonlyArray<ParsedEvidenceAtom['kind']>> }]
        >
      ).map(([gate, spec]) => [gate, spec.oneOf.map((set) => [...set])] as const),
    ),
  ) as Record<VerificationGate, EvidenceAtom['kind'][][]>;

/**
 * Minimum LOC reduction percentage required when the `engine-migration` label
 * is present on a task.
 *
 * Tasks claiming to migrate an engine MUST demonstrate a measurable reduction
 * in lines of code to prevent structural-only migrations (T1604).
 *
 * @task T1604
 */
export const ENGINE_MIGRATION_MIN_REDUCTION_PCT = 10;

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Result of parsing a raw evidence string into structured atoms.
 *
 * @task T832
 */
export interface ParsedEvidence {
  atoms: ParsedAtom[];
}

/**
 * An atom that has been parsed from the CLI syntax but not yet validated
 * against filesystem / git / tools.
 *
 * @task T832
 */
export type ParsedAtom =
  | { kind: 'commit'; sha: string }
  | { kind: 'files'; paths: string[] }
  | { kind: 'test-run'; path: string }
  | { kind: 'tool'; tool: string }
  | { kind: 'url'; url: string }
  | { kind: 'note'; note: string }
  | { kind: 'loc-drop'; fromLines: number; toLines: number }
  | { kind: 'callsite-coverage'; symbolName: string; relativeSourcePath: string }
  | {
      /**
       * Decision atom — a brain_decisions row that IS the canonical artifact
       * for a decision-only task. Satisfies the `implemented` gate when combined
       * with `files:` pointing to a research note.
       *
       * @task T1875
       */
      kind: 'decision';
      /** Decision ID from `brain_decisions.id` (e.g. `"D-arch-001"`). */
      decisionId: string;
    }
  | {
      /**
       * Pull-request atom — references a GitHub PR by number. Validation
       * resolves the PR via `gh pr view` and checks state=MERGED plus
       * all required-workflow checks green. Satisfies `implemented`,
       * `testsPassed`, and `qaPassed` simultaneously (T9838).
       *
       * @task T9764
       * @task T9838
       */
      kind: 'pr';
      /** PR number (positive integer). */
      prNumber: number;
    }
  | {
      /**
       * Cross-task AC-binding atom — references an acceptance criterion on
       * another task in the same Saga (or root Epic when no Saga). The atom
       * carries either the canonical UUIDv4 (`targetAcId`) OR the positional
       * alias (`targetAcAlias`) — never both, never neither. Optional
       * `versionPin` captures the target AC's `updated_at` at mint time.
       *
       * This entry covers PARSING ONLY (T10506); the 5-check validator
       * semantics (target exists, target not terminal, AC exists, same-saga
       * scope) ship in T10507. See ADR-079-r2 §2.1 for the ABNF and §2.4
       * for the runtime validator contract.
       *
       * @task T10506
       * @adr ADR-079-r2
       */
      kind: 'satisfies';
      /** Target task ID — `T<1-7 digits>` per ADR-079-r2 §2.1. */
      targetTaskId: string;
      /** Lowercase UUIDv4 — populated for canonical form; undefined for alias form. */
      targetAcId?: string;
      /** `AC<1-4 digits>` alias — populated for alias form; undefined for UUID form. */
      targetAcAlias?: string;
      /** Optional `@<YYYYMMDDhhmmss>` pin captured at mint time. */
      versionPin?: string;
    };

/**
 * Parse the CLI `--evidence` string into structured atoms.
 *
 * Syntax:
 *   evidence-list := atom ';' atom ';' ...
 *   atom          := kind ':' payload
 *   payload for files: comma-separated paths
 *   payload for everything else: opaque string until next ';'
 *
 * Delegates the syntactic parse to
 * {@link parseEvidenceString} in `@cleocode/contracts` (T10337) and wraps the
 * `EvidenceParseError` in the legacy `CleoError(VALIDATION_ERROR, ...)`
 * envelope so existing CLI surfaces continue to receive the expected exit
 * code and `fix:` hint.
 *
 * @param raw - Raw CLI string from `--evidence`
 * @returns Parsed atoms ready for {@link validateAtom}
 * @throws CleoError(VALIDATION_ERROR) for malformed input
 *
 * @example
 * ```ts
 * parseEvidence('commit:abc123;files:a.ts,b.ts;tool:biome');
 * // => { atoms: [{kind:'commit',sha:'abc123'}, ...] }
 * ```
 *
 * @task T832
 * @task T10337
 */
export function parseEvidence(raw: string): ParsedEvidence {
  try {
    const atoms = parseEvidenceString(raw);
    return { atoms: atoms as ParsedAtom[] };
  } catch (err) {
    if (err instanceof EvidenceParseError) {
      throw new CleoError(ExitCode.VALIDATION_ERROR, err.message, { fix: err.fix });
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

/**
 * Result of validating one atom — success carries the validated form
 * (with sha256 / exit codes populated), failure carries a human-readable
 * reason string.
 *
 * @task T832
 */
export type AtomValidation =
  | { ok: true; atom: EvidenceAtom }
  | { ok: false; reason: string; codeName: string };

/**
 * Validate a single parsed atom against the filesystem / git / tools.
 *
 * @param parsed - Parsed atom from {@link parseEvidence}
 * @param projectRoot - Absolute path to project root (for resolving files, git)
 * @returns Validation outcome with canonicalised form on success
 *
 * @task T832
 * @adr ADR-051 §3
 */
export async function validateAtom(
  parsed: ParsedAtom,
  projectRoot: string,
  /** T9178: When provided, validates commit is on task/<taskId> branch. */
  taskId?: string,
): Promise<AtomValidation> {
  switch (parsed.kind) {
    case 'commit':
      return validateCommit(parsed.sha, projectRoot, taskId);
    case 'files':
      return validateFiles(parsed.paths, projectRoot);
    case 'test-run':
      return validateTestRun(parsed.path, projectRoot);
    case 'tool':
      return validateTool(parsed.tool, projectRoot);
    case 'url':
      return validateUrl(parsed.url);
    case 'note':
      return validateNote(parsed.note);
    case 'loc-drop':
      return validateLocDrop(parsed.fromLines, parsed.toLines);
    case 'callsite-coverage':
      return validateCallsiteCoverage(parsed.symbolName, parsed.relativeSourcePath, projectRoot);
    case 'decision':
      return validateDecision(parsed.decisionId, projectRoot);
    case 'pr':
      return validatePrAtom(parsed.prNumber, projectRoot);
    case 'satisfies': {
      // ADR-079-r2: 5-check validator pipeline shipped by T10507.
      // Delegates to the dedicated validator module to keep the dispatch
      // switch focused. The 5 checks run IN ORDER, first-failure-wins
      // (see `lifecycle/verification/satisfies-validator.ts` for the
      // detailed contract).
      const { validateSatisfiesAtom } = await import(
        '../lifecycle/verification/satisfies-validator.js'
      );
      const result = await validateSatisfiesAtom(
        {
          kind: 'satisfies',
          targetTaskId: parsed.targetTaskId,
          targetAcId: parsed.targetAcId,
          targetAcAlias: parsed.targetAcAlias,
          versionPin: parsed.versionPin,
        },
        taskId,
        projectRoot,
      );
      if (!result.ok) {
        return { ok: false, reason: result.reason, codeName: result.codeName };
      }
      return { ok: true, atom: result.atom };
    }
    default: {
      // Exhaustiveness check — never reachable if ParsedAtom is complete.
      return { ok: false, reason: `Unknown parsed atom`, codeName: 'E_EVIDENCE_INVALID' };
    }
  }
}

/**
 * T9178: Validates commit is on task branch when taskId provided.
 *
 * T9245: ALSO validates commit's diff intersects the task's acceptance-criteria
 * file list. Closes the content-mismatch loophole proven 2026-05-12: a worker
 * could pass `--evidence commit:<sha>` with a SHA that touched zero AC files
 * because validateCommit only ever checked SHA reachability. 13 mis-completed
 * tasks across the 2026-05-11 campaign exploited this. Audit:
 * `.cleo/rcasd/campaign-validation-2026-05-12/SYNTHESIS.md`.
 *
 * ## Worktree-aware HEAD resolution (T-WT-1 / T-WT-3)
 *
 * The original `--is-ancestor <sha> HEAD` check used the literal `HEAD` in the
 * context of `projectRoot`. When `projectRoot` resolves to the main repo root
 * (e.g., because `CLEO_WORKTREE_ROOT` is absent from the subprocess env),
 * `HEAD` points to the main branch tip. A commit on `task/<taskId>` — the
 * standard IVTR deliverable — is NOT an ancestor of the main branch tip until
 * the PR is merged, causing Bug A false failures (see ADR-051-worktree-extension
 * §Bugs).
 *
 * Fix (T-WT-3): The ancestry check uses `getEffectiveHead(projectRoot, taskId)`
 * which returns `"task/<taskId>"` when that branch exists as a git ref, and
 * `"HEAD"` otherwise. This is env-var-independent: it does not rely on the
 * AsyncLocalStorage worktree scope (ADR-041 §D3) being active. When `taskId` is
 * absent, `getEffectiveHead` returns `"HEAD"` and behavior is unchanged.
 *
 * Content-intersect skips when:
 *   - taskId is not provided (legacy call sites)
 *   - task cannot be loaded (best-effort tolerance — do not break verify)
 *   - task.kind ∈ {research, spike} (no code change expected)
 *   - the task declares no AC file paths at all (neither task.files nor
 *     parseable path tokens in task.acceptance strings) — see
 *     {@link extractTaskAcFiles}
 *
 * @param sha - Commit SHA to validate (7-40 hex chars).
 * @param projectRoot - Absolute path used as cwd for git operations. May be
 *   the main repo root or a git worktree path — git resolves commits from
 *   either because they share the object store.
 * @param taskId - Optional CLEO task ID. When provided, triggers branch-scope
 *   check (T9178), content-intersect check (T9245), and worktree-aware HEAD
 *   resolution via {@link getEffectiveHead} (T-WT-1).
 *
 * @task T9178
 * @task T9245
 * @task T-WT-1
 * @task T-WT-3
 * @adr ADR-051
 * @adr ADR-051-worktree-extension
 */
async function validateCommit(
  sha: string,
  projectRoot: string,
  taskId?: string,
): Promise<AtomValidation> {
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) {
    return {
      ok: false,
      reason: `Invalid SHA format: "${sha}" (expected 7-40 hex chars)`,
      codeName: 'E_EVIDENCE_INVALID',
    };
  }
  const exists = await runCommand('git', ['cat-file', '-e', `${sha}^{commit}`], projectRoot);
  if (exists.exitCode !== 0) {
    return {
      ok: false,
      reason: `Commit not found in repository: ${sha}`,
      codeName: 'E_EVIDENCE_INVALID',
    };
  }
  // T-WT-3: resolve effective HEAD — uses task/<taskId> branch when it exists,
  // falls back to "HEAD" when taskId is absent or the branch does not yet exist.
  // This is env-var-independent: it does not rely on CLEO_WORKTREE_ROOT / ALS.
  const effectiveHead = await getEffectiveHead(projectRoot, taskId);
  const reachable = await runCommand(
    'git',
    ['merge-base', '--is-ancestor', sha, effectiveHead],
    projectRoot,
  );
  if (reachable.exitCode !== 0) {
    return {
      ok: false,
      reason: `Commit ${sha} exists but is not reachable from ${effectiveHead}`,
      codeName: 'E_EVIDENCE_INVALID',
    };
  }
  // T9178: branch-scope check — reject cross-branch fabricated SHAs.
  // When the validator is invoked in the context of a specific task, require
  // that the supplied SHA is reachable from task/<taskId>. This blocks the
  // "worker claims `implemented` with a SHA on main but never on task branch"
  // failure mode. The check no-ops if the task branch does not yet exist
  // (e.g. owner-driven completion of a meta-task that never had a worktree).
  if (taskId) {
    const branchRef = `task/${taskId}`;
    const branchExists = await runCommand('git', ['rev-parse', '--verify', branchRef], projectRoot);
    if (branchExists.exitCode === 0) {
      const onBranch = await runCommand(
        'git',
        ['merge-base', '--is-ancestor', sha, branchRef],
        projectRoot,
      );
      if (onBranch.exitCode !== 0) {
        return {
          ok: false,
          reason: `Commit ${sha} not reachable from ${branchRef} — possible phantom evidence`,
          codeName: 'E_EVIDENCE_INVALID',
        };
      }
    }

    // T9245: content-intersect check — diff MUST touch at least one AC file.
    const intersectResult = await checkCommitContentIntersect(sha, taskId, projectRoot);
    if (!intersectResult.ok) {
      return intersectResult;
    }
  }
  const short = await runCommand('git', ['rev-parse', '--short', sha], projectRoot);
  const shortSha = short.stdout.trim() || sha.slice(0, 7);
  const full = await runCommand('git', ['rev-parse', sha], projectRoot);
  const fullSha = full.stdout.trim() || sha;
  return { ok: true, atom: { kind: 'commit', sha: fullSha, shortSha } };
}

/**
 * Path-token regex used by {@link extractTaskAcFiles} to recover AC file paths
 * from free-text acceptance strings when {@link Task.files} is empty.
 *
 * Matches dotted/slashed tokens that look like a source path. Permissive on
 * extension to allow `.md`, `.json`, `.sql`, etc. The orchestrator's preferred
 * SSoT is the explicit `task.files` array — string-token parsing is a
 * fallback for legacy tasks that predate the `--files` flag.
 *
 * @task T9245
 */
const AC_PATH_TOKEN =
  /(?:^|[\s"'`([])([a-zA-Z0-9_\-./@]+\/[a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]{1,8})(?=$|[\s"'`)\],;:])/g;

/**
 * Extract the canonical list of files a task's acceptance criteria declare.
 *
 * Resolution order:
 *   1. `task.files` array — authoritative when populated (set via `--files`)
 *   2. AC string parsing — extract path-like tokens from each
 *      `task.acceptance` string
 *
 * Returns `null` when the task declares no AC files at all — caller MUST
 * interpret this as "skip content-intersect" rather than "verify fails".
 *
 * @internal
 * @task T9245
 */
export function extractTaskAcFiles(task: {
  files?: string[] | null;
  acceptance?: ReadonlyArray<unknown> | null;
}): string[] | null {
  // 1. Explicit files array wins.
  if (task.files && task.files.length > 0) {
    return [...task.files];
  }
  // 2. Parse path tokens from AC strings.
  if (!task.acceptance || task.acceptance.length === 0) {
    return null;
  }
  const parsed = new Set<string>();
  for (const item of task.acceptance) {
    if (typeof item !== 'string') continue;
    // Reset regex state for each iteration (g flag).
    AC_PATH_TOKEN.lastIndex = 0;
    let m: RegExpExecArray | null = AC_PATH_TOKEN.exec(item);
    while (m !== null) {
      if (m[1]) parsed.add(m[1]);
      m = AC_PATH_TOKEN.exec(item);
    }
  }
  return parsed.size > 0 ? Array.from(parsed) : null;
}

/**
 * Run `git show --name-only <sha>` and return the list of file paths the
 * commit touched (added, modified, or deleted). Empty array on git failure.
 *
 * @internal
 * @task T9245
 */
async function gitShowFiles(sha: string, projectRoot: string): Promise<string[]> {
  const r = await runCommand('git', ['show', '--name-only', '--pretty=format:', sha], projectRoot);
  if (r.exitCode !== 0) return [];
  return r.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Determine whether `<commit-diff> ∩ <task-AC-files>` is non-empty.
 *
 * Tolerates path mismatches caused by:
 *   - leading `./` prefix
 *   - trailing slashes (directories listed in AC)
 *   - case-insensitive filesystems (rare on Linux/CI but defensive)
 *
 * @internal
 * @task T9245
 */
function diffIntersectsAc(diffFiles: string[], acFiles: string[]): boolean {
  const norm = (s: string): string => s.replace(/^\.\//, '').replace(/\/+$/, '').toLowerCase();
  const acSet = new Set(acFiles.map(norm));
  const acPrefixes = acFiles.map(norm).filter((p) => !p.includes('.') || p.endsWith('/'));
  for (const f of diffFiles) {
    const nf = norm(f);
    if (acSet.has(nf)) return true;
    // Directory-style AC entry: e.g. AC says `packages/core/src/tasks/`,
    // diff touches `packages/core/src/tasks/evidence.ts`.
    for (const prefix of acPrefixes) {
      if (nf.startsWith(`${prefix}/`)) return true;
    }
  }
  return false;
}

/**
 * Resolve a worktree path to the canonical main repo path by parsing
 * the .git gitlink file. Returns projectRoot as-is for non-worktree dirs.
 *
 * When a git worktree is active, `.git` is a plain FILE containing a line of
 * the form `gitdir: /abs/path/to/main/.git/worktrees/<name>`. Stripping the
 * last 3 path components from that gitdir path yields the main repo root.
 *
 * Used by {@link checkCommitContentIntersect} to ensure task metadata is always
 * read from the canonical `tasks.db` in the main repository rather than from
 * the stale point-in-time copy that was bootstrapped into the worktree at spawn
 * time (Bug C from the E-WORKTREE-IVTR spec).
 *
 * @param projectRoot - Absolute path that may be a git worktree or the main repo.
 * @returns Absolute path to the canonical main repository root.
 *
 * @task T-WT-2
 * @epic T9586
 */
export function resolveCanonicalProjectRoot(projectRoot: string): string {
  try {
    const gitPath = join(projectRoot, '.git');
    const st = statSync(gitPath);
    if (st.isDirectory()) return projectRoot; // normal repo — already canonical
    if (st.isFile()) {
      const content = readFileSync(gitPath, 'utf8').trim();
      // gitlink format: "gitdir: /abs/path/to/main/.git/worktrees/<name>"
      const match = content.match(/^gitdir:\s*(.+)$/);
      if (!match) return projectRoot;
      const gitdirPath = resolvePath(projectRoot, match[1].trim());
      // gitdirPath ends with /.git/worktrees/<name>; main repo is 3 levels up
      const worktreesDir = dirname(gitdirPath); // .../.git/worktrees
      const dotGit = dirname(worktreesDir); // .../.git
      const mainRepo = dirname(dotGit); // main repo root
      // Resolve symlinks (needed on macOS where /var → /private/var) so that
      // the returned path compares equal to realpathSync(env.tempDir) in tests
      // and matches what getTaskAccessor() uses for DB-path construction.
      try {
        return realpathSync(mainRepo);
      } catch {
        return mainRepo;
      }
    }
  } catch {
    /* fall through — not a valid git repo or stat failed */
  }
  return projectRoot;
}

/**
 * Content-intersect check for {@link validateCommit}.
 *
 * Loads the task by ID, derives the AC file list, runs
 * `git show --name-only <sha>`, and verifies the intersection is non-empty.
 *
 * Returns `ok: true` (the no-op signal) when the task cannot be loaded or
 * when AC file extraction returns null — these are tolerated to avoid
 * breaking legacy / decision-only / research tasks.
 *
 * ## Worktree-aware DB resolution (T-WT-2)
 *
 * The original implementation called `getTaskAccessor(projectRoot)` directly.
 * When the AsyncLocalStorage worktree scope (ADR-041 §D3) is active,
 * `getProjectRoot()` returns the worktree path, and `projectRoot` here is the
 * worktree root. The worktree's `.cleo/tasks.db` is a point-in-time spawn
 * snapshot — it receives no writes after creation.
 *
 * Bug C: If the orchestrator updates `task.files` or `task.acceptance` after
 * spawn, the stale worktree DB produces a wrong `acFiles` list. The most
 * common manifestation is a vacuous pass (`acFiles = null` because stale DB
 * has `task.files = []`), which silently bypasses the T9245 content-intersect
 * gate for correctly-spawned IVTR workers.
 *
 * Fix (T-WT-2): This function calls `resolveCanonicalProjectRoot(projectRoot)`
 * to obtain the main repo root before opening `tasks.db`. The canonical main
 * DB is authoritative for all task metadata reads during gate verification.
 * Git operations (`gitShowFiles`) continue to use `projectRoot` as `cwd` —
 * git resolves commits correctly from any directory sharing the object store.
 *
 * @param sha - Commit SHA whose diff is inspected.
 * @param taskId - CLEO task ID used to load AC file declarations.
 * @param projectRoot - Absolute path for git operations (may be worktree path).
 *   DB reads use `resolveCanonicalProjectRoot(projectRoot)` internally.
 *
 * @internal
 * @task T9245
 * @task T-WT-2
 * @adr ADR-051-worktree-extension
 */
async function checkCommitContentIntersect(
  sha: string,
  taskId: string,
  projectRoot: string,
): Promise<AtomValidation> {
  // BUG-C FIX (T-WT-2 / E-WORKTREE-IVTR): always read task metadata from the
  // canonical (main) repository DB. When projectRoot is a worktree path the
  // worktree's tasks.db is a stale spawn-time snapshot; the main DB is the
  // authoritative source for task.files and task.acceptance. git operations
  // below (gitShowFiles) still use the original projectRoot — git shares its
  // object store across worktrees, so any dir in the shared tree works.
  const canonicalRoot = resolveCanonicalProjectRoot(projectRoot);

  // Best-effort load — DB unavailability MUST NOT block verify.
  let task: {
    files?: string[] | null;
    acceptance?: unknown[] | null;
    kind?: string | null;
  } | null = null;
  try {
    const { getTaskAccessor } = await import('../store/data-accessor.js');
    const accessor = await getTaskAccessor(canonicalRoot);
    task = await accessor.loadSingleTask(taskId);
  } catch {
    // Tolerate: legacy callers, init-time use, test stubs.
    return { ok: true, atom: { kind: 'commit', sha, shortSha: sha.slice(0, 7) } };
  }
  if (!task) {
    return { ok: true, atom: { kind: 'commit', sha, shortSha: sha.slice(0, 7) } };
  }
  // Research / spike tasks legitimately produce no code change.
  if (task.kind === 'research' || task.kind === 'spike') {
    return { ok: true, atom: { kind: 'commit', sha, shortSha: sha.slice(0, 7) } };
  }
  const acFiles = extractTaskAcFiles({
    files: task.files,
    acceptance: task.acceptance as ReadonlyArray<unknown> | null | undefined,
  });
  // No declared AC files — cannot enforce intersection (legacy tasks).
  if (!acFiles || acFiles.length === 0) {
    return { ok: true, atom: { kind: 'commit', sha, shortSha: sha.slice(0, 7) } };
  }
  const diffFiles = await gitShowFiles(sha, projectRoot);
  if (diffFiles.length === 0) {
    return {
      ok: false,
      reason:
        `Commit ${sha.slice(0, 7)} touches no files — cannot satisfy implemented gate ` +
        `for task ${taskId} (expected diff to include at least one of: ${acFiles.slice(0, 5).join(', ')}` +
        `${acFiles.length > 5 ? '…' : ''})`,
      codeName: 'E_EVIDENCE_CONTENT_MISMATCH',
    };
  }
  if (!diffIntersectsAc(diffFiles, acFiles)) {
    return {
      ok: false,
      reason:
        `Commit ${sha.slice(0, 7)} diff does not intersect task ${taskId} AC files. ` +
        `Diff touched: [${diffFiles.slice(0, 5).join(', ')}${diffFiles.length > 5 ? '…' : ''}]. ` +
        `AC declared: [${acFiles.slice(0, 5).join(', ')}${acFiles.length > 5 ? '…' : ''}]. ` +
        `T9245: the commit MUST modify at least one declared AC file.`,
      codeName: 'E_EVIDENCE_CONTENT_MISMATCH',
    };
  }
  // Pass — caller's outer validateCommit will produce the final atom.
  return { ok: true, atom: { kind: 'commit', sha, shortSha: sha.slice(0, 7) } };
}

async function validateFiles(paths: string[], projectRoot: string): Promise<AtomValidation> {
  if (paths.length === 0) {
    return {
      ok: false,
      reason: 'files: atom requires at least one path',
      codeName: 'E_EVIDENCE_INVALID',
    };
  }
  const files: Array<{ path: string; sha256: string }> = [];
  for (const p of paths) {
    const abs = isAbsolute(p) ? p : resolvePath(projectRoot, p);
    if (!existsSync(abs)) {
      return {
        ok: false,
        reason: `File does not exist: ${p}`,
        codeName: 'E_EVIDENCE_INVALID',
      };
    }
    const st = await stat(abs);
    if (!st.isFile()) {
      return {
        ok: false,
        reason: `Path is not a regular file: ${p}`,
        codeName: 'E_EVIDENCE_INVALID',
      };
    }
    const content = await readFile(abs);
    const sha256 = createHash('sha256').update(content).digest('hex');
    files.push({ path: p, sha256 });
  }
  return { ok: true, atom: { kind: 'files', files } };
}

interface VitestJsonLike {
  testResults?: Array<{ status?: string; name?: string }>;
  numTotalTests?: number;
  numPassedTests?: number;
  numFailedTests?: number;
  numPendingTests?: number;
  numTodoTests?: number;
}

async function validateTestRun(path: string, projectRoot: string): Promise<AtomValidation> {
  const abs = isAbsolute(path) ? path : resolvePath(projectRoot, path);
  if (!existsSync(abs)) {
    return {
      ok: false,
      reason: `test-run file does not exist: ${path}`,
      codeName: 'E_EVIDENCE_INVALID',
    };
  }
  let content: Buffer;
  try {
    content = await readFile(abs);
  } catch (err) {
    return {
      ok: false,
      reason: `Cannot read test-run file: ${err instanceof Error ? err.message : String(err)}`,
      codeName: 'E_EVIDENCE_INVALID',
    };
  }
  const sha256 = createHash('sha256').update(content).digest('hex');

  let parsed: VitestJsonLike;
  try {
    parsed = JSON.parse(content.toString('utf-8'));
  } catch (err) {
    return {
      ok: false,
      reason: `test-run file is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      codeName: 'E_EVIDENCE_INVALID',
    };
  }

  const total = parsed.numTotalTests ?? 0;
  const failed = parsed.numFailedTests ?? 0;
  const passed = parsed.numPassedTests ?? 0;
  const pending = (parsed.numPendingTests ?? 0) + (parsed.numTodoTests ?? 0);

  if (total === 0) {
    return {
      ok: false,
      reason: 'test-run reports zero total tests (no tests were executed)',
      codeName: 'E_EVIDENCE_TESTS_FAILED',
    };
  }
  if (failed > 0) {
    return {
      ok: false,
      reason: `test-run reports ${failed} failed tests`,
      codeName: 'E_EVIDENCE_TESTS_FAILED',
    };
  }
  if (Array.isArray(parsed.testResults)) {
    const notPassing = parsed.testResults.filter(
      (tr) => tr.status && tr.status !== 'passed' && tr.status !== 'skipped',
    );
    if (notPassing.length > 0) {
      return {
        ok: false,
        reason: `test-run contains ${notPassing.length} non-passing suites`,
        codeName: 'E_EVIDENCE_TESTS_FAILED',
      };
    }
  }

  return {
    ok: true,
    atom: {
      kind: 'test-run',
      path,
      sha256,
      passCount: passed,
      failCount: failed,
      skipCount: pending,
    },
  };
}

async function validateTool(tool: string, projectRoot: string): Promise<AtomValidation> {
  const resolution = resolveToolCommand(tool, projectRoot);
  if (!resolution.ok) {
    return {
      ok: false,
      reason: resolution.reason,
      codeName:
        resolution.codeName === 'E_TOOL_UNKNOWN'
          ? 'E_EVIDENCE_INVALID'
          : 'E_EVIDENCE_TOOL_UNAVAILABLE',
    };
  }

  const result = await runToolCached(resolution.command, projectRoot);

  if (result.exitCode === null) {
    return {
      ok: false,
      reason:
        `Tool "${tool}" → ${resolution.command.cmd} ${resolution.command.args.join(' ')} ` +
        `could not be executed (binary missing or spawn error)`,
      codeName: 'E_EVIDENCE_TOOL_UNAVAILABLE',
    };
  }

  if (result.exitCode !== 0) {
    const tail = tailString(`${result.stdoutTail}\n${result.stderrTail}`, 512);
    return {
      ok: false,
      reason:
        `Tool "${tool}" exited with code ${result.exitCode}` +
        `${result.cacheHit ? ' (cached)' : ''}. Tail: ${tail}`,
      codeName: 'E_EVIDENCE_TOOL_FAILED',
    };
  }

  return {
    ok: true,
    atom: { kind: 'tool', tool, exitCode: 0, stdoutTail: result.stdoutTail },
  };
}

// Re-export so downstream code can keep importing the canonical-tools list
// from evidence.ts without crossing into tool-resolver internals.
export { CANONICAL_TOOLS };

function validateUrl(url: string): AtomValidation {
  if (!/^https?:\/\//.test(url)) {
    return {
      ok: false,
      reason: `url atom must start with http:// or https://`,
      codeName: 'E_EVIDENCE_INVALID',
    };
  }
  return { ok: true, atom: { kind: 'url', url } };
}

function validateNote(note: string): AtomValidation {
  if (!note || note.length === 0) {
    return {
      ok: false,
      reason: 'note atom is empty',
      codeName: 'E_EVIDENCE_INVALID',
    };
  }
  if (note.length > 512) {
    return {
      ok: false,
      reason: `note is too long (${note.length} > 512 chars)`,
      codeName: 'E_EVIDENCE_INVALID',
    };
  }
  return { ok: true, atom: { kind: 'note', note } };
}

/**
 * Validate a `loc-drop` atom: both counts must be non-negative integers and
 * `fromLines` must be strictly greater than zero (cannot reduce from nothing).
 *
 * The reduction percentage is computed and stored but the threshold check
 * (whether the percentage meets the required minimum) is performed separately
 * in `checkEngineMigrationLocDrop` so the gate logic stays decoupled from
 * atom validation.
 *
 * @param fromLines - Line count of the original file.
 * @param toLines - Line count of the migrated file.
 * @returns Validated atom on success, error on invalid input.
 *
 * @task T1604
 */
function validateLocDrop(fromLines: number, toLines: number): AtomValidation {
  if (!Number.isInteger(fromLines) || fromLines < 0) {
    return {
      ok: false,
      reason: `loc-drop: fromLines must be a non-negative integer, got ${fromLines}`,
      codeName: 'E_EVIDENCE_INVALID',
    };
  }
  if (!Number.isInteger(toLines) || toLines < 0) {
    return {
      ok: false,
      reason: `loc-drop: toLines must be a non-negative integer, got ${toLines}`,
      codeName: 'E_EVIDENCE_INVALID',
    };
  }
  if (fromLines === 0) {
    return {
      ok: false,
      reason: `loc-drop: fromLines cannot be zero (nothing to reduce)`,
      codeName: 'E_EVIDENCE_INVALID',
    };
  }
  if (toLines > fromLines) {
    return {
      ok: false,
      reason: `loc-drop: toLines (${toLines}) is greater than fromLines (${fromLines}) — LOC increased, not dropped`,
      codeName: 'E_EVIDENCE_INSUFFICIENT',
    };
  }
  const reductionPct = Math.round(((fromLines - toLines) / fromLines) * 100 * 100) / 100;
  return { ok: true, atom: { kind: 'loc-drop', fromLines, toLines, reductionPct } };
}

/**
 * Check that the provided evidence atoms satisfy the LOC-drop requirement for
 * engine-migration tasks.
 *
 * Returns `null` when the requirement is satisfied; otherwise returns a human-
 * readable reason string suitable for use as an `E_EVIDENCE_INSUFFICIENT`
 * error message.
 *
 * @param atoms - Already-validated evidence atoms.
 * @param minReductionPct - Minimum reduction percentage required (default: 10%).
 * @returns `null` on success, error message on failure.
 *
 * @task T1604
 */
export function checkEngineMigrationLocDrop(
  atoms: EvidenceAtom[],
  minReductionPct: number = ENGINE_MIGRATION_MIN_REDUCTION_PCT,
): string | null {
  const locDropAtom = atoms.find((a) => a.kind === 'loc-drop') as
    | Extract<EvidenceAtom, { kind: 'loc-drop' }>
    | undefined;

  if (!locDropAtom) {
    return (
      `Gate 'implemented' on engine-migration tasks requires a 'loc-drop' evidence atom. ` +
      `Example: --evidence "commit:<sha>;files:<path>;loc-drop:<fromLines>:<toLines>". ` +
      `The migrated engine must shed ≥${minReductionPct}% of its lines.`
    );
  }

  if (locDropAtom.reductionPct < minReductionPct) {
    return (
      `loc-drop: reduction of ${locDropAtom.reductionPct}% is below the required ` +
      `${minReductionPct}% for engine-migration tasks ` +
      `(from=${locDropAtom.fromLines} lines, to=${locDropAtom.toLines} lines). ` +
      `The migrated engine must shed ≥${minReductionPct}% of its lines.`
    );
  }

  return null;
}

// ---------------------------------------------------------------------------
// Callsite-coverage atom (T1605)
// ---------------------------------------------------------------------------

/**
 * The canonical label that triggers callsite-coverage gate enforcement.
 *
 * When a task carries this label the `implemented` gate MUST be accompanied
 * by a `callsite-coverage` evidence atom proving the exported symbol is
 * referenced from a production callsite.
 *
 * @task T1605
 */
export const CALLSITE_COVERAGE_LABEL = 'callsite-coverage';

/**
 * Validate a `callsite-coverage` atom by running ripgrep across the project,
 * excluding the definition file itself, test files, and dist directories.
 *
 * A callsite is any file that contains the `symbolName` identifier outside of:
 * - The source file itself (`relativeSourcePath`).
 * - Test files (`*.test.ts`, `*.spec.ts`, files under `__tests__/`).
 * - Built output (`dist/`, `node_modules/`).
 *
 * Requires `rg` (ripgrep) on the PATH.  Falls back gracefully with
 * `E_EVIDENCE_TOOL_FAILED` when ripgrep is unavailable so callers get a clear
 * diagnostic rather than a silent pass.
 *
 * @param symbolName - The exported identifier to search for.
 * @param relativeSourcePath - Source file path relative to project root
 *   (definition file — excluded from the search).
 * @param projectRoot - Absolute path to the CLEO project root.
 * @returns Validated atom (with `hitCount`) on success, error on failure.
 *
 * @task T1605
 */
async function validateCallsiteCoverage(
  symbolName: string,
  relativeSourcePath: string,
  projectRoot: string,
): Promise<AtomValidation> {
  if (!symbolName || typeof symbolName !== 'string') {
    return {
      ok: false,
      reason: `callsite-coverage: symbolName must be a non-empty string`,
      codeName: 'E_EVIDENCE_INVALID',
    };
  }
  if (!relativeSourcePath || typeof relativeSourcePath !== 'string') {
    return {
      ok: false,
      reason: `callsite-coverage: relativeSourcePath must be a non-empty string`,
      codeName: 'E_EVIDENCE_INVALID',
    };
  }

  // Build the ripgrep command.
  // Exclude: the definition file, test files, dist/, and node_modules/.
  const rgArgs = [
    '--fixed-strings',
    symbolName,
    '--glob',
    '!*.test.ts',
    '--glob',
    '!*.spec.ts',
    '--glob',
    '!**/__tests__/**',
    '--glob',
    '!**/dist/**',
    '--glob',
    '!**/node_modules/**',
    '--glob',
    `!${relativeSourcePath}`,
    '--count-matches',
    '--no-heading',
    '.',
  ];

  const result = await runCommand('rg', rgArgs, projectRoot);

  // rg exits 0 when matches found, 1 when no matches, 2 on error.
  if (result.exitCode === 2 || (result.exitCode !== 0 && result.exitCode !== 1)) {
    const isNotFound =
      result.stderr.includes('No such file or directory') ||
      result.stderr.includes('command not found') ||
      result.stderr.includes('not found');
    if (isNotFound || result.exitCode === null) {
      return {
        ok: false,
        reason:
          `callsite-coverage: ripgrep (rg) is not available on PATH. ` +
          `Install ripgrep to use callsite-coverage atoms.`,
        codeName: 'E_EVIDENCE_TOOL_FAILED',
      };
    }
    return {
      ok: false,
      reason: `callsite-coverage: ripgrep failed (exit ${result.exitCode}): ${result.stderr.slice(0, 200)}`,
      codeName: 'E_EVIDENCE_TOOL_FAILED',
    };
  }

  // Parse match counts from rg --count-matches output.
  // Each line is: <filepath>:<count>
  let totalHits = 0;
  if (result.exitCode === 0) {
    for (const line of result.stdout.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const lastColon = trimmed.lastIndexOf(':');
      if (lastColon < 0) continue;
      const count = parseInt(trimmed.slice(lastColon + 1), 10);
      if (Number.isFinite(count) && count > 0) {
        totalHits += count;
      }
    }
  }

  if (totalHits === 0) {
    return {
      ok: false,
      reason:
        `callsite-coverage: exported symbol "${symbolName}" has no production callsite. ` +
        `No references found outside "${relativeSourcePath}", test files, and dist directories. ` +
        `Wire the symbol to a production callsite before verifying the implemented gate.`,
      codeName: 'E_EVIDENCE_INSUFFICIENT',
    };
  }

  return {
    ok: true,
    atom: { kind: 'callsite-coverage', symbolName, relativeSourcePath, hitCount: totalHits },
  };
}

// ---------------------------------------------------------------------------
// Decision atom (T1875)
// ---------------------------------------------------------------------------

/**
 * Validate a `decision` atom by checking the brain_decisions row exists
 * and has `confirmation_state` in (`accepted`, `proposed`).
 *
 * @param decisionId - The brain_decisions.id to look up (e.g. `"D-arch-001"`).
 * @param projectRoot - Absolute path to the CLEO project root.
 * @returns Validated atom on success, error on failure.
 *
 * @task T1875
 * @epic T1824
 */
async function validateDecision(decisionId: string, projectRoot: string): Promise<AtomValidation> {
  if (!decisionId || typeof decisionId !== 'string') {
    return {
      ok: false,
      reason: `decision: decisionId must be a non-empty string`,
      codeName: 'E_EVIDENCE_INVALID',
    };
  }

  try {
    const { getBrainDb } = await import('../store/memory-sqlite.js');
    const { eq } = await import('drizzle-orm');
    const db = await getBrainDb(projectRoot);

    const brainSchema = await import('../store/schema/memory-schema.js');
    const rows = await db
      .select()
      .from(brainSchema.brainDecisions)
      .where(eq(brainSchema.brainDecisions.id, decisionId))
      .all();

    if (rows.length === 0) {
      return {
        ok: false,
        reason:
          `decision: no brain_decisions row found with id "${decisionId}". ` +
          `Record the decision first via 'cleo memory observe' and promote it, ` +
          `or use 'cleo decision record' to create a formal decision entry.`,
        codeName: 'E_EVIDENCE_INVALID_DECISION',
      };
    }

    const row = rows[0];
    const confirmationState = row.confirmationState as string | null;
    const validStates = ['accepted', 'proposed'];

    if (!validStates.includes(confirmationState ?? '')) {
      return {
        ok: false,
        reason:
          `decision: brain_decisions row "${decisionId}" has confirmation_state ` +
          `"${confirmationState ?? 'null'}" — expected one of: ${validStates.join(', ')}. ` +
          `Accept or propose the decision before using it as evidence.`,
        codeName: 'E_EVIDENCE_INVALID_DECISION',
      };
    }

    return {
      ok: true,
      atom: { kind: 'decision', decisionId },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (
      msg.includes('no such table') ||
      msg.includes('brain_decisions') ||
      msg.includes('SQLITE_ERROR')
    ) {
      return {
        ok: false,
        reason:
          `decision: brain_decisions table not found or inaccessible. ` +
          `Ensure the BRAIN DB is initialized and the decisions table exists.`,
        codeName: 'E_EVIDENCE_INVALID_DECISION',
      };
    }
    return {
      ok: false,
      reason: `decision: DB lookup for "${decisionId}" failed: ${msg}`,
      codeName: 'E_EVIDENCE_INVALID_DECISION',
    };
  }
}

// ---------------------------------------------------------------------------
// PR atom (T9764)
// ---------------------------------------------------------------------------

/**
 * Validate a `pr:<number>` atom by resolving the PR via the `gh` CLI.
 *
 * Delegates to {@link resolvePrEvidenceAtom} so the network round-trip,
 * cache, and required-workflow evaluation live in one place
 * (`packages/core/src/release/pr-evidence.ts`).
 *
 * @param prNumber - PR number (positive integer).
 * @param projectRoot - Absolute path to the project root.
 * @returns Validated atom on success, error on failure.
 *
 * @task T9764
 */
async function validatePrAtom(prNumber: number, projectRoot: string): Promise<AtomValidation> {
  // Dynamic import keeps the verification module free of a static dependency
  // on the release subtree, mirroring the pattern used by validateDecision.
  const { resolvePrEvidenceAtom } = await import('../release/pr-evidence.js');
  const result = await resolvePrEvidenceAtom(prNumber, projectRoot);
  if (!result.ok) {
    return { ok: false, reason: result.reason, codeName: result.codeName };
  }
  return {
    ok: true,
    atom: {
      kind: 'pr',
      prNumber: result.prNumber,
      mergeCommitSha: result.mergeCommitSha,
      mergedAt: result.mergedAt,
      successCount: result.successCount,
      totalChecks: result.totalChecks,
    },
  };
}

/**
 * Check that the provided evidence atoms satisfy the callsite-coverage
 * requirement for tasks carrying the `callsite-coverage` label.
 *
 * Returns `null` when the requirement is satisfied; otherwise returns a
 * human-readable reason string suitable for use as an `E_EVIDENCE_INSUFFICIENT`
 * error message.
 *
 * @param atoms - Already-validated evidence atoms.
 * @returns `null` on success, error message string on failure.
 *
 * @task T1605
 */
export function checkCallsiteCoverageAtom(atoms: EvidenceAtom[]): string | null {
  const hasCallsiteAtom = atoms.some((a) => a.kind === 'callsite-coverage');
  if (!hasCallsiteAtom) {
    return (
      `Gate 'implemented' on callsite-coverage tasks requires a 'callsite-coverage' evidence atom. ` +
      `Example: --evidence "commit:<sha>;files:<path>;callsite-coverage:<symbolName>:<relativeSourcePath>". ` +
      `The exported symbol must be referenced from at least one production callsite.`
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Gate minimum evaluation
// ---------------------------------------------------------------------------

/**
 * Check whether a set of validated atoms satisfies the minimum evidence
 * required for a given gate.
 *
 * @param gate - The gate being verified
 * @param atoms - Validated atoms
 * @returns null when satisfied; otherwise the reason message
 *
 * @task T832
 * @adr ADR-051 §2.3
 */
export function checkGateEvidenceMinimum(
  gate: VerificationGate,
  atoms: EvidenceAtom[],
): string | null {
  // Delegate to the SSoT in @cleocode/contracts (T10337). validateEvidenceForGate
  // only inspects `.kind`; the post-validation EvidenceAtom union includes the
  // `override` kind which is never present here (override-evidence flows skip
  // the minimum check entirely in engine-ops.ts). Project to the parsed-atom
  // kind set, dropping any `override` entry so the schema's narrower
  // discriminator is satisfied without a wider cast on the call site.
  const projected: Array<{ kind: ParsedEvidenceAtom['kind'] }> = [];
  for (const atom of atoms) {
    if (atom.kind === 'override') continue;
    // The narrowing above eliminates the 'override' literal — the remaining
    // kinds match ParsedEvidenceAtom['kind'] one-for-one.
    const kind: ParsedEvidenceAtom['kind'] = atom.kind;
    projected.push({ kind });
  }
  const result = validateEvidenceForGate(gate, projected);
  return result.ok ? null : result.message;
}

/**
 * Detailed variant of {@link checkGateEvidenceMinimum} that returns the
 * machine-readable failure (with `message` + `hint`) instead of a flat
 * string. Use this when the caller needs the multi-line CLI `fix:` hint
 * (T9949) — `E_EVIDENCE_INSUFFICIENT` surfaces in engine-ops.ts populate
 * `engineError({fix: result.hint})` with this output.
 *
 * Returns `null` when the gate is satisfied.
 *
 * @param gate - The gate being verified
 * @param atoms - Validated atoms
 * @returns `null` when satisfied; `{ message, hint }` when not
 *
 * @task T9949
 * @adr ADR-051 §2.3
 */
export function checkGateEvidenceMinimumDetailed(
  gate: VerificationGate,
  atoms: EvidenceAtom[],
): { message: string; hint: string } | null {
  const projected: Array<{ kind: ParsedEvidenceAtom['kind'] }> = [];
  for (const atom of atoms) {
    if (atom.kind === 'override') continue;
    const kind: ParsedEvidenceAtom['kind'] = atom.kind;
    projected.push({ kind });
  }
  const result = validateEvidenceForGate(gate, projected);
  return result.ok ? null : { message: result.message, hint: result.hint };
}

/**
 * Compose a {@link GateEvidence} record from validated atoms.
 *
 * @param atoms - Validated evidence atoms
 * @param capturedBy - Agent identifier
 * @param override - True when CLEO_OWNER_OVERRIDE is set
 * @param overrideReason - Reason supplied with the override
 * @returns Canonical GateEvidence ready to persist
 *
 * @task T832
 */
export function composeGateEvidence(
  atoms: EvidenceAtom[],
  capturedBy: string,
  override?: boolean,
  overrideReason?: string,
): GateEvidence {
  const result: GateEvidence = {
    atoms,
    capturedAt: new Date().toISOString(),
    capturedBy,
  };
  if (override) {
    result.override = true;
    if (overrideReason) result.overrideReason = overrideReason;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Re-verification (staleness check at complete time)
// ---------------------------------------------------------------------------

/**
 * Result of re-verifying stored evidence at complete time.
 *
 * @task T832
 */
export interface RevalidationResult {
  stillValid: boolean;
  failedAtoms: Array<{ atom: EvidenceAtom; reason: string }>;
}

/**
 * Critical gates for which `override`-only evidence is NEVER accepted. Closes
 * the override-loophole proven 2026-05-12 — 13 mis-completed tasks in the
 * 2026-05-11 campaign passed `implemented`/`testsPassed` with override-only
 * evidence. Audit: `.cleo/rcasd/campaign-validation-2026-05-12/SYNTHESIS.md`.
 *
 * Other gates (`qaPassed`, `documented`, `securityPassed`, `cleanupDone`,
 * `nexusImpact`) MAY still accept `note:` waivers / overrides per ADR-051.
 *
 * @task T9245
 * @adr ADR-051
 */
export const CRITICAL_GATES_NO_OVERRIDE: readonly VerificationGate[] = Object.freeze([
  'implemented',
  'testsPassed',
]);

/**
 * Re-validate stored evidence to detect tampering between verify and complete.
 *
 * Hard atoms (commit, files, test-run, tool) are re-executed. Soft atoms
 * (url, note, override) pass through unchanged.
 *
 * T9245: when `gate` ∈ {@link CRITICAL_GATES_NO_OVERRIDE}, override-only
 * evidence is rejected at re-validation time. Forces the worker to produce
 * real programmatic proof for `implemented` and `testsPassed`.
 *
 * @param evidence - Previously-stored evidence
 * @param projectRoot - Absolute path to project root
 * @param gate - Optional gate name; when provided enables the critical-gate
 *   override-rejection check (T9245). Omit for back-compat callers.
 * @returns Revalidation outcome
 *
 * @task T832
 * @task T9245
 * @adr ADR-051 §5 / §8 (Decision 8)
 */
export async function revalidateEvidence(
  evidence: GateEvidence,
  projectRoot: string,
  gate?: VerificationGate,
): Promise<RevalidationResult> {
  // T9245: critical-gate override rejection.
  // When the gate is `implemented` or `testsPassed`, evidence that has no
  // non-override hard atom is rejected outright. We define "override-only"
  // as: evidence.override === true AND every recorded atom is either
  // `kind: 'override'` or `kind: 'note'` (notes alone are insufficient too).
  if (gate && CRITICAL_GATES_NO_OVERRIDE.includes(gate)) {
    const hasHardAtom = evidence.atoms.some(
      (a) => a.kind !== 'override' && a.kind !== 'note' && a.kind !== 'url',
    );
    if (evidence.override === true && !hasHardAtom) {
      return {
        stillValid: false,
        failedAtoms: [
          {
            atom: { kind: 'override', reason: evidence.overrideReason ?? 'unspecified' },
            reason:
              `T9245: gate '${gate}' rejects override-only evidence. ` +
              `Critical gates (${CRITICAL_GATES_NO_OVERRIDE.join(', ')}) require a hard atom ` +
              `(commit/files/test-run/tool). Re-verify with real evidence.`,
          },
        ],
      };
    }
  }

  if (evidence.override) {
    // Override evidence on non-critical gates is not re-validated — it had no
    // programmatic proof to begin with.
    return { stillValid: true, failedAtoms: [] };
  }

  const failed: Array<{ atom: EvidenceAtom; reason: string }> = [];

  for (const atom of evidence.atoms) {
    switch (atom.kind) {
      case 'url':
      case 'note':
      case 'override':
        break;
      case 'commit': {
        const check = await validateCommit(atom.sha, projectRoot);
        if (!check.ok) failed.push({ atom, reason: check.reason });
        break;
      }
      case 'files': {
        for (const f of atom.files) {
          const abs = isAbsolute(f.path) ? f.path : resolvePath(projectRoot, f.path);
          if (!existsSync(abs)) {
            failed.push({ atom, reason: `File removed since verify: ${f.path}` });
            break;
          }
          const content = await readFile(abs);
          const sha256 = createHash('sha256').update(content).digest('hex');
          if (sha256 !== f.sha256) {
            failed.push({
              atom,
              reason: `File modified since verify: ${f.path} (expected ${f.sha256.slice(0, 8)}, got ${sha256.slice(0, 8)})`,
            });
            break;
          }
        }
        break;
      }
      case 'test-run': {
        const abs = isAbsolute(atom.path) ? atom.path : resolvePath(projectRoot, atom.path);
        if (!existsSync(abs)) {
          failed.push({ atom, reason: `test-run file removed since verify: ${atom.path}` });
          break;
        }
        const content = await readFile(abs);
        const sha256 = createHash('sha256').update(content).digest('hex');
        if (sha256 !== atom.sha256) {
          failed.push({ atom, reason: `test-run output modified since verify: ${atom.path}` });
        }
        break;
      }
      case 'tool': {
        // Tool atoms are not re-executed (too slow for every complete call);
        // they are trusted once verified. Evidence for qaPassed / testsPassed
        // should use test-run / files to anchor the state.
        break;
      }
      case 'loc-drop':
        // LOC counts are immutable once captured — no re-execution possible.
        // The counts are structural facts about the migration; the atom is
        // trusted as-is once validated at verify time.
        break;
      case 'callsite-coverage':
        // Callsite hit counts are captured at verify time and treated as
        // immutable structural facts — no re-execution at complete time.
        break;
      case 'decision':
        // Decision atoms reference brain_decisions rows which are immutable
        // once accepted/proposed. Re-validation is not performed at complete
        // time — the DB row is trusted as captured at verify time.
        break;
      case 'pr':
        // PR atoms capture (prNumber, mergedAt, mergeCommitSha) at verify
        // time. A merged PR's mergedAt is immutable, so the atom is trusted
        // as captured. Re-validation would require another `gh` round trip
        // and add network dependency to every `cleo complete` invocation.
        break;
      case 'satisfies':
        // ADR-079-r2: satisfies bindings resolve to evidence_satisfies_bindings
        // rows owned by the T10507 validator. The row's target_ac_uuid is the
        // immutable canonical form; the W_AC_ALIAS_DRIFTED warning surface
        // (validator-side) gives the author one cycle to update before the
        // next verify rejects. No re-validation at complete time — the
        // recorded canonical UUID is the immutable trust surface.
        break;
      default:
        // Exhaustiveness — unreachable if EvidenceAtom is complete.
        break;
    }
  }

  return { stillValid: failed.length === 0, failedAtoms: failed };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

function runCommand(cmd: string, args: string[], cwd: string): Promise<CommandResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout?.on('data', (d) => {
      stdout += d.toString('utf-8');
    });
    child.stderr?.on('data', (d) => {
      stderr += d.toString('utf-8');
    });
    child.on('error', () => {
      resolve({ exitCode: null, stdout, stderr });
    });
    child.on('close', (code) => {
      resolve({ exitCode: code, stdout, stderr });
    });
  });
}

function tailString(s: string, max: number): string {
  if (s.length <= max) return s;
  return '…' + s.slice(s.length - max + 1);
}
