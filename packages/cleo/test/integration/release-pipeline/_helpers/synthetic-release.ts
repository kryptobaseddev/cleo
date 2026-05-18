/**
 * Synthetic Release builder for integration tests (T9543).
 *
 * Spins up a deterministic, throwaway project tree in `os.tmpdir()` that
 * mirrors one of the three release-archetype fixtures landed in T9542:
 *
 * - `monorepo`     → release-test-monorepo
 * - `npm-lib`      → release-test-npm-lib
 * - `rust-crate`   → release-test-rust-crate
 *
 * The builder copies the fixture into a fresh tmp dir, runs `git init`,
 * seeds N synthetic commits (each formatted as a conventional-commit message
 * referencing a task ID), and emits a {@link ReleasePlan}-shaped JSON object
 * that satisfies the {@link ReleasePlanSchema} contract from
 * `@cleocode/contracts`.
 *
 * Tests use the returned `{ tmpDir, plan, taskIds, commits }` handle to:
 *
 * 1. Point CLI helpers (or stubbed verbs) at `tmpDir` as the project root.
 * 2. Assert on the plan envelope without touching real release verbs.
 * 3. Inject failure modes (F1-F10) by passing `includeForensics`.
 *
 * NOTE: This helper is intentionally synchronous on the git side — it relies
 * on a single bounded `execFileSync` per commit with a 5s timeout so a wedged
 * git invocation does not hang the test runner (the very failure mode the
 * pipeline itself defends against per F1).
 *
 * @task T9543
 * @epic T9495
 */

import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type ReleasePlan,
  RELEASE_PLAN_SCHEMA_URL,
  ReleasePlanSchema,
} from '@cleocode/contracts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Canonical archetype identifier matching the fixtures landed in T9542.
 *
 * Each archetype maps 1:1 to a directory under `packages/cleo/test/fixtures/`.
 */
export type SyntheticArchetype = 'monorepo' | 'npm-lib' | 'rust-crate';

/**
 * Forensics failure-mode injection tags from
 * `.cleo/rcasd/T9345/research/failure-forensics-10-modes.md`.
 *
 * `none` is the no-injection baseline used by S1 (happy path).
 */
export type ForensicsInjection =
  | 'none'
  | 'F1'
  | 'F2'
  | 'F3'
  | 'F4'
  | 'F5'
  | 'F6'
  | 'F7'
  | 'F8'
  | 'F9'
  | 'F10';

/**
 * Options accepted by {@link createSyntheticRelease}.
 */
export interface CreateSyntheticReleaseOptions {
  /** Which archetype fixture to copy as the project root. */
  archetype: SyntheticArchetype;
  /** Number of synthetic commits + task rows to seed (1..50). */
  taskCount: number;
  /** Optional forensics failure-mode injection (default: `'none'`). */
  includeForensics?: ForensicsInjection;
  /** Optional version override (default: `'v2026.6.0'`). */
  version?: string;
  /** Optional epic ID override (default: `'T9495'`). */
  epicId?: string;
}

/**
 * Result handle returned by {@link createSyntheticRelease}.
 */
export interface SyntheticRelease {
  /** Absolute path to the tmp project root. Must be cleaned by the caller. */
  tmpDir: string;
  /** Validated release plan envelope (parses cleanly via `ReleasePlanSchema`). */
  plan: ReleasePlan;
  /** Task IDs in plan-order (T10001, T10002, ...). */
  taskIds: string[];
  /** Commit SHAs in commit-order (oldest first). */
  commits: string[];
  /** Archetype this synthesis was built against. */
  archetype: SyntheticArchetype;
  /** Forensics injection that was applied (or `'none'`). */
  forensics: ForensicsInjection;
}

/**
 * Path to the `packages/cleo/test/fixtures/` directory, resolved relative to
 * this helper's source file. The synthetic-release builder copies one of these
 * fixtures into `tmpDir` rather than re-creating the file layout inline.
 */
const FIXTURES_ROOT = resolve(__dirname, '..', '..', '..', 'fixtures');

/**
 * Maps {@link SyntheticArchetype} to the corresponding fixture directory name.
 */
const FIXTURE_DIR_BY_ARCHETYPE: Record<SyntheticArchetype, string> = {
  monorepo: 'release-test-monorepo',
  'npm-lib': 'release-test-npm-lib',
  'rust-crate': 'release-test-rust-crate',
};

/**
 * Returns the absolute path to the fixture root for a given archetype.
 *
 * Exposed for tests that need to inspect the fixture without copying it.
 */
export function fixturePathFor(archetype: SyntheticArchetype): string {
  return join(FIXTURES_ROOT, FIXTURE_DIR_BY_ARCHETYPE[archetype]);
}

/**
 * Runs git with a hard 5s timeout. Throws on non-zero exit or timeout.
 *
 * Centralized so every helper that shells out to git inherits the same
 * cwd-locked, timeout-bounded contract — preventing the F1 failure mode from
 * sneaking into the test harness itself.
 */
function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 5_000,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'cleo-test',
      GIT_AUTHOR_EMAIL: 'cleo-test@example.com',
      GIT_COMMITTER_NAME: 'cleo-test',
      GIT_COMMITTER_EMAIL: 'cleo-test@example.com',
    },
  }).trim();
}

/**
 * Initializes a bare git repo + initial empty commit in `cwd`.
 */
function initGitRepo(cwd: string): void {
  git(cwd, ['init', '--quiet', '--initial-branch=main']);
  git(cwd, ['config', 'commit.gpgsign', 'false']);
  // Mark this dir as a safe git directory so root-owned CI runners pass.
  git(cwd, ['config', 'safe.directory', cwd]);
  writeFileSync(join(cwd, '.gitkeep'), '');
  git(cwd, ['add', '.gitkeep']);
  git(cwd, ['commit', '--quiet', '-m', 'chore: initial commit']);
}

/**
 * Seeds N synthetic commits in `cwd`, returning the commit SHAs in order.
 *
 * Each commit:
 * - Touches a unique file `synthetic/<task-id>.txt` so it has real content.
 * - Has a conventional-commit subject `feat(T#####): synthetic task #N`.
 * - Carries a task-ID footer line so the release verbs can scrape it.
 */
function seedCommits(cwd: string, taskIds: string[]): string[] {
  const syntheticDir = join(cwd, 'synthetic');
  mkdirSync(syntheticDir, { recursive: true });
  const shas: string[] = [];
  for (let i = 0; i < taskIds.length; i += 1) {
    const id = taskIds[i] ?? `T${10001 + i}`;
    const fp = join(syntheticDir, `${id}.txt`);
    writeFileSync(fp, `synthetic task ${id} payload\n`);
    git(cwd, ['add', `synthetic/${id}.txt`]);
    git(cwd, ['commit', '--quiet', '-m', `feat(${id}): synthetic task #${i + 1}\n\nRefs: ${id}`]);
    shas.push(git(cwd, ['rev-parse', 'HEAD']));
  }
  return shas;
}

/**
 * Returns a deterministic ISO-8601 timestamp pinned to plan creation time.
 *
 * Tests assert on plan envelopes so a stable timestamp avoids spurious diffs.
 */
function planTimestamp(): string {
  return '2026-06-01T12:00:00Z';
}

/**
 * Builds the `tasks[]` array from the seeded task IDs.
 */
function buildTasks(taskIds: string[], epicId: string): ReleasePlan['tasks'] {
  return taskIds.map((id, idx) => ({
    id,
    kind: 'feat' as const,
    impact: 'minor' as const,
    userFacingSummary: `Synthetic task ${id} for release-pipeline integration tests`,
    evidenceAtoms: [`commit:synthetic-${idx + 1}`, 'tool:test', 'tool:lint'],
    ivtrPhaseAtPlan: 'released',
    epicAncestor: epicId,
  }));
}

/**
 * Builds the canonical `gates[]` array — all 6 ADR-061 gate names with status
 * `passed`. Tests that inject F3/F4 mutate this in-place after the fact.
 */
function buildGates(): ReleasePlan['gates'] {
  const verifiedAt = planTimestamp();
  return [
    {
      name: 'test',
      atom: 'tool:test',
      status: 'passed',
      lastVerifiedAt: verifiedAt,
      resolvedCommand: 'pnpm run test',
      resolvedSource: 'project-context',
    },
    {
      name: 'build',
      atom: 'tool:build',
      status: 'passed',
      lastVerifiedAt: verifiedAt,
      resolvedCommand: 'pnpm run build',
      resolvedSource: 'project-context',
    },
    {
      name: 'lint',
      atom: 'tool:lint',
      status: 'passed',
      lastVerifiedAt: verifiedAt,
      resolvedCommand: 'pnpm biome check .',
      resolvedSource: 'language-default',
    },
    {
      name: 'typecheck',
      atom: 'tool:typecheck',
      status: 'passed',
      lastVerifiedAt: verifiedAt,
      resolvedCommand: 'pnpm run typecheck',
      resolvedSource: 'language-default',
    },
    {
      name: 'audit',
      atom: 'tool:audit',
      status: 'passed',
      lastVerifiedAt: verifiedAt,
      resolvedCommand: 'pnpm audit',
      resolvedSource: 'language-default',
    },
    {
      name: 'security-scan',
      atom: 'tool:security-scan',
      status: 'passed',
      lastVerifiedAt: verifiedAt,
      resolvedCommand: 'pnpm run security-scan',
      resolvedSource: 'language-default',
    },
  ];
}

/**
 * Builds the platformMatrix from the archetype's release-config.json.
 *
 * Falls back to a single `any/npm` entry if the fixture's config cannot be
 * read (e.g. missing in a future fixture).
 */
function buildPlatformMatrix(archetype: SyntheticArchetype): ReleasePlan['platformMatrix'] {
  switch (archetype) {
    case 'monorepo':
      return [
        { platform: 'any', publisher: 'npm', package: '@release-test/pkg-a', smoke: true },
        { platform: 'any', publisher: 'npm', package: '@release-test/pkg-b', smoke: true },
      ];
    case 'npm-lib':
      return [
        { platform: 'any', publisher: 'npm', package: 'release-test-npm-lib', smoke: true },
      ];
    case 'rust-crate':
      return [
        {
          platform: 'linux-x64',
          publisher: 'cargo',
          package: 'release-test-rust-crate',
          smoke: true,
        },
        {
          platform: 'linux-arm64',
          publisher: 'cargo',
          package: 'release-test-rust-crate',
          smoke: true,
        },
      ];
  }
}

/**
 * Builds the changelog buckets from a task list. All synthetic tasks are
 * `kind=feat`, so everything lands in `features`.
 */
function buildChangelog(taskIds: string[]): ReleasePlan['changelog'] {
  return {
    features: [...taskIds],
    fixes: [],
    chores: [],
    breaking: [],
  };
}

/**
 * Assembles + validates the {@link ReleasePlan} envelope.
 *
 * Throws ZodError if the resulting plan does not satisfy
 * {@link ReleasePlanSchema}. Tests rely on the throw to catch helper bit-rot
 * as the contract evolves.
 */
function buildPlan(
  archetype: SyntheticArchetype,
  taskIds: string[],
  opts: { version: string; epicId: string },
): ReleasePlan {
  const draft = {
    $schema: RELEASE_PLAN_SCHEMA_URL,
    version: opts.version,
    resolvedVersion: opts.version,
    suffixApplied: false,
    scheme: 'calver' as const,
    channel: 'latest' as const,
    epicId: opts.epicId,
    releaseKind: 'regular' as const,
    createdAt: planTimestamp(),
    createdBy: 'cleo-test',
    previousVersion: 'v2026.5.78',
    previousTag: 'v2026.5.78',
    previousShippedAt: '2026-05-16T00:00:00Z',
    tasks: buildTasks(taskIds, opts.epicId),
    changelog: buildChangelog(taskIds),
    gates: buildGates(),
    platformMatrix: buildPlatformMatrix(archetype),
    preflightSummary: {
      esbuildExternalsDrift: false,
      lockfileDrift: false,
      epicCompletenessClean: true,
      doubleListingClean: true,
      preflightWarnings: [],
    },
    workflowRunUrl: null,
    prUrl: null,
    mergeCommitSha: null,
    status: 'planned' as const,
    meta: { archetype: archetype as string },
  };
  return ReleasePlanSchema.parse(draft);
}

/**
 * Generates an array of synthetic task IDs starting at T10001.
 */
function makeTaskIds(count: number): string[] {
  if (count < 1 || count > 50) {
    throw new Error(`createSyntheticRelease: taskCount must be 1..50 (got ${count})`);
  }
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    ids.push(`T${10001 + i}`);
  }
  return ids;
}

/**
 * Applies forensics-specific mutations to the plan envelope.
 *
 * Each branch encodes the minimal mutation needed to surface the failure mode
 * during a downstream pipeline op:
 *
 * - F2 — sets `epicAncestor` on one task to an unrelated epic so completeness
 *   checks must respect scope. Mirrors test-matrix S3 + S6.
 * - F3 / F4 — marks a gate as `unresolved` so gate-runner execution can
 *   distinguish "passed" from "actually-ran-and-passed". Mirrors S4.
 * - F6 — clears `mergeCommitSha` so S5's tag-on-merge-SHA assertion can
 *   force-set it from the mock-gh response.
 * - F8 — leaves status at `planned` but pre-records `prUrl` so resume can
 *   pick up from the durable checkpoint mid-flight. Mirrors S7.
 * - F1, F5, F7, F9, F10, none — no plan mutation; failure mode is exercised
 *   by the test runner (e.g. F1 is a wedged-git timeout the test triggers).
 */
function applyForensics(plan: ReleasePlan, mode: ForensicsInjection): ReleasePlan {
  if (mode === 'none') return plan;
  // Use a shallow clone of tasks/gates so the original plan stays parseable.
  const mutated: ReleasePlan = {
    ...plan,
    tasks: plan.tasks.map((t) => ({ ...t })),
    gates: plan.gates.map((g) => ({ ...g })),
  };
  switch (mode) {
    case 'F2': {
      // Leak: one task's epicAncestor points at an unrelated epic.
      if (mutated.tasks.length > 0) {
        mutated.tasks[0] = { ...mutated.tasks[0]!, epicAncestor: 'T-UNRELATED' };
      }
      return mutated;
    }
    case 'F3':
    case 'F4': {
      // Gate runner not wired: mark the `test` gate as unresolved.
      const idx = mutated.gates.findIndex((g) => g.name === 'test');
      if (idx >= 0) {
        const existing = mutated.gates[idx]!;
        mutated.gates[idx] = {
          ...existing,
          status: 'unresolved',
          resolvedCommand: undefined,
          resolvedSource: undefined,
        };
      }
      return mutated;
    }
    case 'F6': {
      // Tag-on-merge-SHA: leave mergeCommitSha null so the test must populate
      // it from the mock-gh response and assert the tag lands on that SHA.
      mutated.mergeCommitSha = null;
      return mutated;
    }
    case 'F8': {
      // Resume-mid-flight: advance status to pr-opened with a fake prUrl.
      mutated.status = 'pr-opened';
      mutated.prUrl = 'https://github.com/example/repo/pull/9999';
      return mutated;
    }
    case 'F1':
    case 'F5':
    case 'F7':
    case 'F9':
    case 'F10':
      // No plan mutation needed — test runner injects the failure.
      return mutated;
  }
}

/**
 * Creates a self-contained synthetic release in a tmpdir.
 *
 * The caller is responsible for cleanup (`rmSync(tmpDir, { recursive: true })`).
 * Tests typically scope cleanup to an `afterEach` so a failing assertion does
 * not leak the tmp dir.
 *
 * @example
 * ```ts
 * const synth = createSyntheticRelease({
 *   archetype: 'npm-lib',
 *   taskCount: 3,
 *   includeForensics: 'F2',
 * });
 * try {
 *   expect(synth.plan.tasks).toHaveLength(3);
 * } finally {
 *   rmSync(synth.tmpDir, { recursive: true, force: true });
 * }
 * ```
 */
export function createSyntheticRelease(opts: CreateSyntheticReleaseOptions): SyntheticRelease {
  const forensics: ForensicsInjection = opts.includeForensics ?? 'none';
  const version = opts.version ?? 'v2026.6.0';
  const epicId = opts.epicId ?? 'T9495';
  const tmpDir = mkdtempSync(join(tmpdir(), `cleo-release-${opts.archetype}-`));

  // Copy the fixture into tmpDir so each test gets a pristine tree.
  const fixtureRoot = fixturePathFor(opts.archetype);
  cpSync(fixtureRoot, tmpDir, { recursive: true });

  initGitRepo(tmpDir);
  const taskIds = makeTaskIds(opts.taskCount);
  const commits = seedCommits(tmpDir, taskIds);

  const basePlan = buildPlan(opts.archetype, taskIds, { version, epicId });
  const plan = applyForensics(basePlan, forensics);

  return {
    tmpDir,
    plan,
    taskIds,
    commits,
    archetype: opts.archetype,
    forensics,
  };
}

/**
 * Writes a plan JSON to the synthetic release's `.cleo/release/<v>.plan.json`
 * path and returns the absolute path. Mirrors what `cleo release plan` would
 * write if it were available.
 */
export function writePlanFile(synth: SyntheticRelease): string {
  const dir = join(synth.tmpDir, '.cleo', 'release');
  mkdirSync(dir, { recursive: true });
  const fp = join(dir, `${synth.plan.version}.plan.json`);
  writeFileSync(fp, `${JSON.stringify(synth.plan, null, 2)}\n`);
  return fp;
}
