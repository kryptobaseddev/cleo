/**
 * `cleo check pr` — unified local pre-PR gate (T11956 · DHQ-073 · Epic T11679).
 *
 * Runs the SAME high-signal gates that CI runs, locally, in one command, and
 * returns a single pass/fail summary so an agent can self-verify BEFORE
 * opening a PR. This closes the DHQ-073 gap: there was no single "run exactly
 * the CI required-gates locally" command, so agents repeatedly hit
 * Type-Check / Canon-Drift / Install-Test failures only after CI ran.
 *
 * Design (CORE-first, per AGENTS.md Package-Boundary Check)
 * --------------------------------------------------------
 * The gate REGISTRY and the RUNNER live here in `@cleocode/core`. The CLI
 * handler in `packages/cleo` is a thin dispatch that calls {@link runPrGate}
 * and renders the result. No business logic lives in the CLI layer.
 *
 * Memory safety
 * -------------
 * Heavy gates (build, typecheck, test) are cgroup-capped on Linux via
 * `systemd-run --user --scope -p MemoryMax=… -p MemorySwapMax=0` when the
 * binary is available — mirroring the project's OOM-safety discipline. The cap
 * is best-effort: if `systemd-run` is absent (macOS / minimal CI) the gate
 * runs uncapped.
 *
 * @task T11956
 * @epic T11679 (DHQ burn-down)
 * @see docs/release/branch-protection-setup.md § "Required Status Checks"
 */

import { spawnSync } from 'node:child_process';
import { getProjectRoot } from '../paths.js';

/**
 * A single runnable pre-PR gate. The `command` + `args` are executed verbatim
 * (no shell) from the repository root.
 */
export interface PrGateDef {
  /** Stable machine id (kebab-case) used in results and `--only` filters. */
  readonly id: string;
  /** Human-readable label shown in the summary. */
  readonly label: string;
  /** The executable to run (e.g. `pnpm`, `node`, `cleo`). */
  readonly command: string;
  /** Arguments passed to the executable. */
  readonly args: readonly string[];
  /**
   * Whether this gate is memory-heavy and should be cgroup-capped on Linux.
   * Lint gates are cheap; build/typecheck/test are heavy.
   */
  readonly heavy: boolean;
  /**
   * `core` gates run by default. `full` gates run only with `full: true` —
   * the complete CI lint surface, which is slower and rarely needed for a
   * focused change.
   */
  readonly tier: 'core' | 'full';
  /** One-line rationale shown in `--list`. */
  readonly description: string;
}

/**
 * The default MemoryMax applied to heavy gates on Linux. Matches the project's
 * standard cgroup cap for local build/test runs.
 */
const DEFAULT_MEMORY_MAX = '16G';

/**
 * The canonical pre-PR gate registry. The `core` tier mirrors the gates that
 * actually gate `main` and that agents most commonly trip; the `full` tier
 * adds the complete standalone-lint surface for an exhaustive local sweep.
 *
 * Ordered cheapest-first so a fast lint failure surfaces before the slow
 * build/test gates run.
 */
export const PR_GATES: readonly PrGateDef[] = [
  {
    id: 'biome',
    label: 'Biome (lint + format)',
    command: 'pnpm',
    args: ['biome', 'check', '.'],
    heavy: false,
    tier: 'core',
    description: 'Format + lint check (CI: Lint & Format)',
  },
  {
    id: 'lockfile',
    label: 'Lockfile Check',
    command: 'pnpm',
    args: ['install', '--frozen-lockfile'],
    heavy: false,
    tier: 'core',
    description: 'pnpm-lock.yaml is consistent (CI: Lockfile Check)',
  },
  {
    id: 'arch',
    label: 'Architectural Boundary Check (cleo check arch)',
    command: 'cleo',
    args: ['check', 'arch'],
    heavy: false,
    tier: 'core',
    description: 'SG-ARCH-SOLID gates (CI: Arch Boundary Check)',
  },
  {
    id: 'canon-docs',
    label: 'Canon Drift Check (docs SSoT)',
    command: 'cleo',
    args: ['check', 'canon', 'docs'],
    heavy: false,
    tier: 'core',
    description: 'No raw *.md bypassing the docs SSoT (CI: Canon Drift Check)',
  },
  {
    id: 'merge-bar-aggregate',
    label: 'Merge-Bar Aggregate Gate Lint',
    command: 'node',
    args: ['scripts/lint-merge-bar-aggregate.mjs'],
    heavy: false,
    tier: 'core',
    description: 'Every PR-gating workflow keeps a complete aggregate gate (T11955)',
  },
  {
    id: 'typecheck',
    label: 'Type Check (full tsc -b)',
    command: 'pnpm',
    args: ['run', 'typecheck'],
    heavy: true,
    tier: 'core',
    description: 'Full-tree TypeScript build (CI: Type Check)',
  },
  {
    id: 'build',
    label: 'Build',
    command: 'pnpm',
    args: ['run', 'build'],
    heavy: true,
    tier: 'core',
    description: 'Full dependency-graph build (CI: Build & Verify)',
  },
  {
    id: 'test',
    label: 'Unit Tests',
    command: 'pnpm',
    args: ['run', 'test'],
    heavy: true,
    tier: 'core',
    description: 'Vitest suite (CI: Unit Tests shards)',
  },
  // --- full tier: the complete standalone-lint surface ---------------------
  {
    id: 'lint-llm-chokepoint',
    label: 'LLM Chokepoint Guard',
    command: 'node',
    args: ['scripts/lint-llm-chokepoint.mjs'],
    heavy: false,
    tier: 'full',
    description:
      'No-hardcoded-models / out-of-chokepoint LLM construction (CI: Arch Boundary Check)',
  },
  {
    id: 'lint-contracts-dep',
    label: 'Contracts Dep Lint',
    command: 'node',
    args: ['scripts/lint-contracts-dep.mjs'],
    heavy: false,
    tier: 'full',
    description: 'Package boundary dependency lint (CI: Contracts Dep Lint)',
  },
  {
    id: 'lint-deployed-template-parity',
    label: 'Deployed Template Parity',
    command: 'node',
    args: ['scripts/lint-deployed-template-parity.mjs'],
    heavy: false,
    tier: 'full',
    description: 'Rendered workflow templates match deployed (CI: Deployed Template Parity)',
  },
  {
    id: 'lint-publish-surface',
    label: 'Publish Surface Lint',
    command: 'node',
    args: ['scripts/lint-publish-surface.mjs'],
    heavy: false,
    tier: 'full',
    description: 'npm publish surface SSoT (CI: Publish Surface Lint)',
  },
  {
    id: 'lint-no-crate-publish',
    label: 'Crate Publish Guard',
    command: 'node',
    args: ['scripts/lint-no-crate-publish.mjs'],
    heavy: false,
    tier: 'full',
    description: 'Zero crates.io publishes (CI: Crate Publish Guard)',
  },
] as const;

/** Outcome of a single gate. */
export interface PrGateRunResult {
  /** Gate id (matches {@link PrGateDef.id}). */
  readonly id: string;
  /** Gate label. */
  readonly label: string;
  /** Final status. `skipped` means the gate was filtered out by `--only`. */
  readonly status: 'pass' | 'fail' | 'skipped';
  /** Process exit code (null if the process could not be spawned or skipped). */
  readonly exitCode: number | null;
  /** Wall-clock duration in milliseconds. */
  readonly durationMs: number;
  /** Whether the gate was cgroup-capped on this run. */
  readonly capped: boolean;
  /** Last lines of combined stdout/stderr (trimmed) for failure triage. */
  readonly outputTail: string;
}

/** Aggregate result of a `cleo check pr` run. */
export interface PrGateSummary {
  /** Repository root the gates ran against. */
  readonly repoRoot: string;
  /** True iff every non-skipped gate passed. */
  readonly passed: boolean;
  /** Per-gate results in execution order. */
  readonly gates: readonly PrGateRunResult[];
  /** Roll-up counts. */
  readonly summary: { readonly pass: number; readonly fail: number; readonly skipped: number };
}

/** Options controlling a {@link runPrGate} run. */
export interface RunPrGateOptions {
  /** Run the full standalone-lint surface in addition to the core tier. */
  readonly full?: boolean;
  /** Restrict the run to these gate ids (others reported as `skipped`). */
  readonly only?: readonly string[];
  /** Continue running remaining gates after the first failure (default true). */
  readonly keepGoing?: boolean;
  /** MemoryMax for heavy gates on Linux (default `16G`). */
  readonly memoryMax?: string;
  /**
   * Override the working tree the gates run in. Defaults to the git toplevel
   * of `process.cwd()` (so an agent inside a worktree validates THAT worktree,
   * incl. uncommitted changes — not whatever `CLEO_ROOT` points at).
   */
  readonly cwd?: string;
  /**
   * Streaming sink for human progress. Receives one line per lifecycle event.
   * Defaults to a no-op so the function is pure-by-default for tests.
   */
  readonly onProgress?: (line: string) => void;
}

/**
 * Resolve the gate set for a run: the `core` tier always, plus the `full`
 * tier when requested, then narrowed by `only` (which marks the rest skipped).
 *
 * @param opts run options
 * @returns the gates to execute (in registry order) plus the skipped set
 * @internal exported for unit testing
 */
export function selectPrGates(opts: Pick<RunPrGateOptions, 'full' | 'only'>): {
  toRun: PrGateDef[];
  skipped: PrGateDef[];
} {
  const tierFiltered = PR_GATES.filter(
    (g) => g.tier === 'core' || (opts.full && g.tier === 'full'),
  );
  if (!opts.only || opts.only.length === 0) {
    return { toRun: [...tierFiltered], skipped: [] };
  }
  const wanted = new Set(opts.only);
  const toRun = tierFiltered.filter((g) => wanted.has(g.id));
  const skipped = tierFiltered.filter((g) => !wanted.has(g.id));
  return { toRun, skipped };
}

/**
 * Is `systemd-run` available on this host? Probed once and cached for the
 * process lifetime.
 */
let systemdRunAvailable: boolean | undefined;
function hasSystemdRun(): boolean {
  if (systemdRunAvailable !== undefined) return systemdRunAvailable;
  if (process.platform !== 'linux') {
    systemdRunAvailable = false;
    return false;
  }
  const probe = spawnSync('systemd-run', ['--version'], { stdio: 'ignore' });
  systemdRunAvailable = probe.status === 0;
  return systemdRunAvailable;
}

/**
 * Build the argv for a gate, wrapping heavy gates in a cgroup-capped
 * `systemd-run --user --scope` when available on Linux.
 *
 * @param gate the gate definition
 * @param memoryMax MemoryMax value (e.g. `16G`)
 * @returns `{ command, args, capped }`
 * @internal exported for unit testing
 */
export function buildGateArgv(
  gate: PrGateDef,
  memoryMax: string,
): { command: string; args: string[]; capped: boolean } {
  if (gate.heavy && hasSystemdRun()) {
    return {
      command: 'systemd-run',
      args: [
        '--user',
        '--scope',
        '--quiet',
        '-p',
        `MemoryMax=${memoryMax}`,
        '-p',
        'MemorySwapMax=0',
        '--',
        gate.command,
        ...gate.args,
      ],
      capped: true,
    };
  }
  return { command: gate.command, args: [...gate.args], capped: false };
}

/**
 * Resolve the working tree the gates run in: the git toplevel of
 * `process.cwd()` (so the gates validate the agent's actual checkout/worktree
 * incl. uncommitted changes). Falls back to {@link getProjectRoot} when not in
 * a git work tree.
 *
 * @returns absolute path to the working-tree root
 * @internal exported for unit testing
 */
export function resolveWorkingTree(): string {
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (top.status === 0 && typeof top.stdout === 'string' && top.stdout.trim().length > 0) {
    return top.stdout.trim();
  }
  return getProjectRoot();
}

/**
 * Keep only the last `n` non-empty lines of a captured output blob, trimmed.
 *
 * @param output raw combined output
 * @param n max lines to retain
 */
function tailLines(output: string, n: number): string {
  return output
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0)
    .slice(-n)
    .join('\n');
}

/**
 * Run the unified pre-PR gate suite and return a structured summary.
 *
 * Each gate runs as a child process from the repository root. Heavy gates are
 * cgroup-capped on Linux when `systemd-run` is available. By default the run
 * continues after a failure (so the agent sees every problem at once); pass
 * `keepGoing: false` to stop at the first failure.
 *
 * This function performs no process I/O of its own beyond `onProgress`
 * callbacks — the CLI layer owns stdout/stderr rendering.
 *
 * @param opts run options
 * @returns the aggregate {@link PrGateSummary}
 */
export function runPrGate(opts: RunPrGateOptions = {}): PrGateSummary {
  const repoRoot = opts.cwd ?? resolveWorkingTree();
  const memoryMax = opts.memoryMax ?? DEFAULT_MEMORY_MAX;
  const keepGoing = opts.keepGoing ?? true;
  const emit = opts.onProgress ?? (() => {});

  const { toRun, skipped } = selectPrGates(opts);

  const results: PrGateRunResult[] = [];
  let aborted = false;

  for (const gate of toRun) {
    if (aborted) {
      results.push({
        id: gate.id,
        label: gate.label,
        status: 'skipped',
        exitCode: null,
        durationMs: 0,
        capped: false,
        outputTail: 'skipped — earlier gate failed and --keep-going is off',
      });
      continue;
    }

    const { command, args, capped } = buildGateArgv(gate, memoryMax);
    emit(`▶ ${gate.label}${capped ? ` (capped ${memoryMax})` : ''}`);

    const start = Date.now();
    const proc = spawnSync(command, args, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    const durationMs = Date.now() - start;

    const combined = `${proc.stdout ?? ''}\n${proc.stderr ?? ''}`;
    const passed = proc.status === 0;
    results.push({
      id: gate.id,
      label: gate.label,
      status: passed ? 'pass' : 'fail',
      exitCode: proc.status,
      durationMs,
      capped,
      outputTail: passed ? '' : tailLines(combined, 20),
    });

    emit(`${passed ? '✓' : '✗'} ${gate.label} (${(durationMs / 1000).toFixed(1)}s)`);

    if (!passed && !keepGoing) aborted = true;
  }

  for (const gate of skipped) {
    results.push({
      id: gate.id,
      label: gate.label,
      status: 'skipped',
      exitCode: null,
      durationMs: 0,
      capped: false,
      outputTail: 'skipped — not selected by --only',
    });
  }

  const pass = results.filter((r) => r.status === 'pass').length;
  const fail = results.filter((r) => r.status === 'fail').length;
  const skip = results.filter((r) => r.status === 'skipped').length;

  return {
    repoRoot,
    passed: fail === 0,
    gates: results,
    summary: { pass, fail, skipped: skip },
  };
}
