/**
 * Acceptance gate runner — executes typed `AcceptanceGate` items from a
 * task's `acceptance` array and returns structured `AcceptanceGateResult[]`.
 *
 * Supported gate kinds:
 *   - `test`    — spawn a command, assert exit code / stdout
 *   - `file`    — assert file properties (exists, bytes, content)
 *   - `command` — spawn any CLI, assert exit code / stdout / stderr
 *   - `lint`    — run biome/eslint/tsc/prettier/rustc/clippy, assert clean
 *   - `http`    — fetch URL, assert status + optional body
 *   - `manual`  — always returns `skipped` (requires explicit human verdict)
 *
 * Design constraints:
 *   - Each gate is self-contained (no cross-gate state).
 *   - Gates run sequentially under ONE captured operation deadline. The caller admits it
 *     with {@link typedGateAdmissionMs}: the ADR-061 tool deadline of every executing gate
 *     plus {@link TYPED_GATE_BOOKKEEPING_MS} for the surrounding bookkeeping (T12516).
 *   - Per-gate timeouts can only tighten the captured deadline, never renew it.
 *   - Passing process gates can be served from the ADR-061 evidence cache
 *     (`options.cache`, see `gate-result-cache.ts`); failures are never cached (T12621).
 *   - Structured test-count evidence and HTTP service startup require separate capabilities.
 *   - Results are observations; this module does not persist completion authority.
 *
 * @epic T760
 * @task T781
 */

import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  constants,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  type Stats,
  writeFileSync,
} from 'node:fs';
import { lstat, open, readFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type {
  AcceptanceGate,
  AcceptanceGateResult,
  AcRow,
  CommandGate,
  DataAccessor,
  FileAssertion,
  FileGate,
  HttpGate,
  LintGate,
  ManualGate,
  Task,
  TestGate,
} from '@cleocode/contracts';
import type {
  AcceptanceGateArtifact,
  AcceptanceGateBinding,
  AcceptanceGateCacheInputs,
  AcceptanceGateInvocation,
  AcceptanceGateRunOptions,
  AcceptanceGateTreeBinding,
  AcceptanceGateVerificationReceipt,
} from '@cleocode/contracts/acceptance-gate';
import {
  acceptanceGateResultSchema,
  acceptanceGateSchema,
  testCountReportSchema,
  testCountSummarySchema,
} from '@cleocode/contracts/acceptance-gate-schema.js';
import type { OperationExecutionContext } from '@cleocode/contracts/jobs';
import type {
  ProcessCaptureOptions,
  ProcessCaptureResult,
} from '@cleocode/contracts/resource-governor';
import { discoveryEnv, gitToplevel, resolveDeclaredEvidenceGitRoot } from '../git/work-tree.js';
import { getProjectRoot } from '../paths.js';
import { captureProjectScope, worktreeScope } from '../project-scope.js';
import { truncateString } from '../render/helpers.js';
import {
  ADMISSION_ENV,
  footprintForClass,
  planRunFootprint,
} from '../resources/admission-ledger.js';
import { captureWrapped } from '../resources/spawn-wrapper.js';
import { createAttachmentStore } from '../store/attachment-store.js';
import { registerTeardownAbort } from '../teardown-signal.js';
import { acItemToText, acTextHash } from './ac-table.js';
import { splitCommandLine } from './command-line.js';
import { resolveCanonicalProjectRoot } from './evidence.js';
import {
  buildGateCacheEntryBody,
  captureGateCacheState,
  describeGateCacheMiss,
  evidenceCacheKeyPath,
  type GateCacheState,
  gateCacheEntryPath,
  readGateCacheEntry,
  sealGateCacheEntry,
} from './gate-result-cache.js';
import { heavyToolEnv } from './heavy-tool-env.js';
import { resolveSpawnTimeoutMs } from './tool-cache.js';
import { acquireGlobalSlot } from './tool-semaphore.js';

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Shared budget for the bookkeeping around typed gates: task and criterion
 * reads, input snapshots, result binding and the persisting transaction.
 *
 * It is the same two seconds the maintenance paths use, and it is ADDED to the
 * tool deadlines rather than bounding them. Before T12516 it was the whole
 * lifetime of a typed verification, so any gate whose tool ran longer than two
 * seconds — every real test suite — stopped with `E_OPERATION_DEADLINE`.
 *
 * @task T12516
 */
export const TYPED_GATE_BOOKKEEPING_MS = 2000;

/** Gate kinds that execute a tool (a process or a request) and so carry an ADR-061 deadline. */
const TOOL_GATE_KINDS: ReadonlySet<AcceptanceGate['kind']> = new Set([
  'test',
  'command',
  'lint',
  'http',
]);

/** Maximum evidence string character count retained per gate result. */
const MAX_EVIDENCE_CHARS = 2_000;

/** Agent identifier written into `checkedBy`. */
const CHECKED_BY = process.env['CLEO_AGENT_ID'] ?? 'cleo-verify';

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Captured gate-runner options from the canonical shared contract.
 * @remarks Nested invocations retain their original operation authority and deadline.
 * @example
 * ```typescript
 * const options: RunGatesOptions = { projectRoot: '/project' };
 * ```
 */
export type RunGatesOptions = AcceptanceGateRunOptions;

/**
 * Resolve the wall-clock deadline for one gate's tool execution.
 *
 * Precedence: the gate's own `timeoutMs`; then the legacy blanket
 * `CLEO_GATE_TIMEOUT_MS`; then the ADR-061 tool deadline for the gate kind,
 * resolved by {@link resolveSpawnTimeoutMs} — `CLEO_TOOL_TIMEOUT_<KIND>`, else
 * 1,800,000 ms for `test` and 300,000 ms for every other kind.
 *
 * @param gate - Gate whose tool deadline is needed.
 * @param env - Environment to read the overrides from.
 * @returns Deadline in milliseconds.
 * @throws When a declared or configured deadline is not a positive safe integer.
 * @example
 * ```typescript
 * resolveGateTimeoutMs({ kind: 'test', description: 'suite', command: 'npm', args: ['test'], expect: 'exit0' }); // 1_800_000
 * ```
 * @task T12516
 */
export function resolveGateTimeoutMs(
  gate: AcceptanceGate,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const legacy = env['CLEO_GATE_TIMEOUT_MS']?.trim();
  const timeout =
    gate.timeoutMs ??
    (legacy ? Number(legacy) : undefined) ??
    resolveSpawnTimeoutMs(gate.kind, env);
  if (!Number.isSafeInteger(timeout) || timeout < 1)
    throw new Error('Gate timeout must be a positive safe integer');
  return timeout;
}

/**
 * Wall-clock lifetime to admit for running a set of typed gates.
 *
 * The sum of every tool-executing gate's ADR-061 deadline plus
 * {@link TYPED_GATE_BOOKKEEPING_MS}. Callers that own the operation lifetime
 * create it with this budget so the two-second shared budget covers the
 * bookkeeping only and never bounds a tool (T12516).
 *
 * @param gates - Gates that will run.
 * @param env - Environment to read deadline overrides from.
 * @returns Budget in milliseconds, clamped to the safe-integer range.
 * @throws When a gate deadline override is invalid (see {@link resolveGateTimeoutMs}).
 * @example
 * ```typescript
 * const execution = createOperationExecutionContext(identity, { budgetMs: typedGateAdmissionMs(gates) });
 * ```
 * @task T12516
 */
export function typedGateAdmissionMs(
  gates: readonly AcceptanceGate[],
  env: NodeJS.ProcessEnv = process.env,
): number {
  const total = gates.reduce(
    (sum, gate) => sum + (TOOL_GATE_KINDS.has(gate.kind) ? resolveGateTimeoutMs(gate, env) : 0),
    TYPED_GATE_BOOKKEEPING_MS,
  );
  return Math.min(total, Number.MAX_SAFE_INTEGER);
}

/**
 * Actionable refusal for `cache: 'only'` — every evidence write by default
 * (T13521, owner decision: writes read the cache, `cleo verify --run` executes)
 * and `--no-run` — when a gate would have to execute. Names the gate and the
 * command that fills the cache.
 */
function gateNotCachedMessage(
  gate: AcceptanceGate,
  cacheable: boolean,
  keyAvailable: boolean,
): string {
  const name = gate.req ?? gate.description;
  const run = gate.req
    ? `cleo verify <taskId> --run --req ${gate.req}`
    : 'cleo verify <taskId> --run';
  if (gate.kind === 'http')
    return `${GATE_NOT_CACHED_PREFIX} http gate "${name}" observes a live service and is never cached; pass --run-typed to execute it on this write`;
  if (!cacheable)
    return `${GATE_NOT_CACHED_PREFIX} gate "${name}" has no cached result because the project root is not a git checkout (results are keyed by HEAD + dirty-tree fingerprint); pass --run-typed to execute it on this write`;
  if (!keyAvailable)
    return `${GATE_NOT_CACHED_PREFIX} gate "${name}" cannot use the cache because the machine key ${evidenceCacheKeyPath()} is unreadable; pass --run-typed to execute it on this write`;
  return (
    `${GATE_NOT_CACHED_PREFIX} gate "${name}" has no cached pass for the current HEAD, working tree and inputs. ` +
    `Evidence writes do not execute typed gates: run \`${run}\` first (it caches passing results), ` +
    'or pass --run-typed to execute it on this write'
  );
}

/**
 * Prefix of the `errorMessage` a gate carries when `cache: 'only'` refused to
 * execute it. The verifier matches it to refuse the write with
 * `E_GATE_NOT_CACHED` (a gate the write links) or to record it as not run.
 * @task T12621
 * @task T13521
 */
export const GATE_NOT_CACHED_PREFIX = 'typed gate not cached:';

/**
 * Prefix of the `errorMessage` a gate carries when `cache: 'only'` found an
 * entry that failed authentication. The verifier refuses the write with
 * `E_GATE_CACHE_INVALID`: a forged or tampered pass is never recorded.
 * @task T12621
 */
export const GATE_CACHE_INVALID_PREFIX = 'typed gate cache entry invalid:';

/**
 * Load (creating on first use, mode 0600) the per-machine key that seals
 * evidence cache entries. Deliberately NOT exported: a caller that could load
 * the key through core could seal any result it liked, which is the forgery
 * this key exists to stop. Returns `null` when the key cannot be established;
 * the cache is then simply not used.
 */
function loadEvidenceCacheKey(): Buffer | null {
  const path = evidenceCacheKeyPath();
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try {
      writeFileSync(path, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const hex = readFileSync(path, 'utf-8').trim();
    return /^[0-9a-f]{64}$/.test(hex) ? Buffer.from(hex, 'hex') : null;
  } catch {
    return null;
  }
}

/**
 * Seal and store a pass this runner EXECUTED itself. Module-private for the same
 * reason as {@link loadEvidenceCacheKey}: only an observed execution is cached.
 */
function writeExecutedGatePass(
  projectRoot: string,
  gate: AcceptanceGate,
  state: GateCacheState,
  inputsHash: string,
  observed: AcceptanceGateResult,
  key: Buffer,
  inputs?: AcceptanceGateCacheInputs,
): void {
  const body = buildGateCacheEntryBody(gate, state, inputsHash, observed, inputs);
  if (!body) return;
  try {
    const path = gateCacheEntryPath(projectRoot, gate, state, inputsHash);
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(sealGateCacheEntry(body, key), null, 2), 'utf-8');
    renameSync(tmp, path);
  } catch {
    // A cache is an optimisation: failing to persist one never fails the gate.
  }
}

/**
 * Digest of a gate's captured invocation and input artifacts: the part of its
 * cache key that the git fingerprint cannot see (untracked harness scripts,
 * task files, the environment hash).
 */
function gateInputsHash(
  invocation: AcceptanceGateInvocation | undefined,
  artifacts: readonly AcceptanceGateArtifact[],
): string {
  return createHash('sha256')
    .update(JSON.stringify({ invocation: invocation ?? null, artifacts }))
    .digest('hex');
}

/**
 * Compute a gate's cache inputs digest the same way the attesting verifier does.
 * @param task - Task that owns the gate; its `files` are verifier inputs.
 * @param gate - Gate whose invocation and inputs are captured.
 * @param execution - Admitted lifetime whose project root scopes the capture.
 * @param env - Environment the gate will launch with.
 * @returns Digest to pass as `cacheInputsHash` to {@link runGates}.
 * @example
 * ```typescript
 * const cacheInputsHash = await captureGateInputsHash(task, gate, execution);
 * ```
 * @task T12621
 */
export async function captureGateInputsHash(
  task: Task,
  gate: AcceptanceGate,
  execution: OperationExecutionContext,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  return (await captureGateInputs(task, gate, execution, env)).hash;
}

/**
 * {@link captureGateInputsHash} with the parts behind the digest, which a
 * stored pass keeps so a later miss can say what moved (T13693).
 *
 * @param task - Task that owns the gate; its `files` are verifier inputs.
 * @param gate - Gate whose invocation and inputs are captured.
 * @param execution - Admitted lifetime whose project root scopes the capture.
 * @param env - Environment the gate will launch with.
 * @returns The digest and its parts.
 * @task T13693
 */
export async function captureGateInputs(
  task: Task,
  gate: AcceptanceGate,
  execution: OperationExecutionContext,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ hash: string; inputs: AcceptanceGateCacheInputs }> {
  const tree = resolveTypedGateRoot(resolve(execution.identity.projectRoot));
  const invocation = executableInvocation(gate, tree, { ...env });
  const artifacts = await snapshotGateInputs(task, gate, invocation, execution, tree);
  return {
    hash: gateInputsHash(invocation, artifacts),
    inputs: { environmentHash: invocation?.environmentHash ?? null, artifacts },
  };
}

/**
 * The tree a typed gate runs in and is fingerprinted against.
 *
 * `projectRoot` is the CLEO store root, which for a git worktree is the MAIN
 * checkout (all worktrees share one `.cleo/`). Evidence tools already run in the
 * caller's own worktree (gh#1220); typed gates ran in the store root, so from a
 * worktree `cleo done` measured the task's code with its tools and the main
 * checkout with its typed gates (T12625 review). The caller's git toplevel is
 * used only when it is a linked worktree OF THIS project — any other cwd
 * (an unrelated repo, a test harness, a declared child repo in a multi-repo
 * root) keeps `projectRoot`, so typed-gate paths written against the CLEO root
 * keep resolving exactly as before.
 *
 * Known limit (documented, accepted): "linked worktree of this project" is read
 * from the `.git` gitlink, so a plain directory carrying a forged gitlink that
 * points into this project's `.git/worktrees/` is treated as a worktree. That
 * grants nothing a copy of the checkout would not: its typed results are only
 * carried to another tree by content (tracked inputs must hash identically and
 * the recorded HEAD must be merged there).
 *
 * T13649: the evidence declaration (`CLEO_EVIDENCE_GIT_ROOT`, `GIT_WORK_TREE`
 * or `evidence.gitRoot`) is consulted first, as `resolveEvidenceExecutionRoot`
 * does for evidence tools. Without it, a run whose cwd had been moved to the
 * store root keyed the gate cache to the primary checkout's HEAD even when the
 * caller named its worktree. A declared tree is honoured only when it is this
 * project's checkout or one of its linked worktrees, like the cwd.
 *
 * @param projectRoot - CLEO store root (the typed gate's authority).
 * @param cwd - Invocation directory. Defaults to `process.cwd()`.
 * @param env - Where the evidence declaration is read. Defaults to `process.env`.
 * @returns The realpath of the tree typed gates execute in.
 * @task T12625
 * @task T13649
 */
export function resolveTypedGateRoot(
  projectRoot: string,
  cwd: string = process.cwd(), // CWD-OK: the invocation tree is the subject (gh#1220)
  env: NodeJS.ProcessEnv = process.env,
): string {
  const real = (p: string): string => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  const root = real(projectRoot);
  const ofThisProject = (top: string | null): string | null =>
    top !== null && real(top) !== root && real(resolveCanonicalProjectRoot(top)) === root
      ? real(top)
      : null;
  const declared = resolveDeclaredEvidenceGitRoot(projectRoot, env);
  const declaredTop = declared ? gitToplevel(declared.path) : null;
  // A declaration naming the store root itself is honoured as such.
  if (declaredTop !== null && real(declaredTop) === root) return projectRoot;
  return ofThisProject(declaredTop) ?? ofThisProject(gitToplevel(cwd)) ?? projectRoot;
}

/**
 * Admission for a batch run without a caller-owned lifetime.
 * An invalid deadline override is not swallowed: {@link runOneGate} resolves it
 * again and reports it as that gate's `error` result, as it always has.
 */
function unownedAdmissionMs(gates: readonly AcceptanceGate[], env?: NodeJS.ProcessEnv): number {
  try {
    return typedGateAdmissionMs(gates, env);
  } catch {
    return TYPED_GATE_BOOKKEEPING_MS;
  }
}

/**
 * Execute all typed `AcceptanceGate` entries and return results.
 *
 * Free-text strings in the acceptance array MUST be filtered by the caller
 * before invoking this function. Only `AcceptanceGate` objects are accepted.
 *
 * @param gates   - Typed gate objects (strings pre-filtered by caller).
 * @param options - Execution options.
 * @returns       Ordered `AcceptanceGateResult[]`, one per gate.
 * @throws If explicit project authority conflicts, metadata is invalid, or admission options are invalid.
 * @remarks Results retain the original gate requirement ID. Process outcomes include target,
 * transport and cleanup observations; they do not by themselves authorize task completion.
 * Declared operation bytes reserve the per-gate capture ceiling before admission. Filesystem
 * calls and regular-expression CPU work are cooperatively checked, not synchronously preempted.
 * Canonical attachment retrieval validates its declared size but is not a streaming read API.
 * @example
 * ```typescript
 * const results = await runGates([{ kind: 'command', description: 'check', cmd: 'node', args: ['check.mjs'] }], { projectRoot: '/project' });
 * ```
 *
 * @epic T760
 * @task T781
 */
export async function runGates(
  gates: AcceptanceGate[],
  options: RunGatesOptions = {},
): Promise<AcceptanceGateResult[]> {
  const inherited = worktreeScope.getStore();
  if (inherited?.execution && options.execution && inherited.execution !== options.execution)
    throw new Error('Gate execution cannot replace an active captured operation');
  const execution = options.execution ?? inherited?.execution;
  const projectRoot = resolve(
    options.projectRoot ?? execution?.identity.projectRoot ?? getProjectRoot(),
  );
  if (execution && resolve(execution.identity.projectRoot) !== projectRoot)
    throw new Error('Gate execution project does not match captured operation authority');
  const scope = captureProjectScope(projectRoot, {
    ...captureProjectScope(projectRoot, inherited),
    execution,
  });
  const maxOutputBytes = options.maxOutputBytes ?? 1_048_576;
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1)
    throw new RangeError('Gate capture byte limit must be a positive safe integer');
  // T12625: execute and fingerprint in the caller's worktree of this project.
  const treeRoot = resolveTypedGateRoot(projectRoot);
  const snapshot = structuredClone(gates);
  const controller = new AbortController();
  const deregister = registerTeardownAbort(controller);
  const batch: ProcessCaptureOptions = {
    cwd: treeRoot,
    env: { ...(options.env ?? process.env) },
    execution: {
      deadlineAt: execution?.deadlineAt ?? Date.now() + unownedAdmissionMs(snapshot, options.env),
      signal: execution
        ? AbortSignal.any([execution.signal, controller.signal])
        : controller.signal,
    },
    maxOutputBytes,
    memoryMaxMb: options.memoryMaxMb,
    tasksMax: options.tasksMax,
    systemdControl: options.systemdControl,
  };
  const checkedBy = execution?.identity.actor ?? batch.env['CLEO_AGENT_ID'] ?? CHECKED_BY;
  const cacheMode = options.cache ?? 'off';
  const cacheInputsHash = options.cacheInputsHash;
  if (cacheMode !== 'off' && (snapshot.length !== 1 || !cacheInputsHash))
    throw new Error('Typed gate caching requires one gate per batch and its inputs digest');
  // T12621: the repo state is captured only when the policy reads or writes.
  const cacheState =
    cacheMode !== 'off' && TOOL_GATE_KINDS.has(snapshot[0]!.kind)
      ? await captureGateCacheState(treeRoot)
      : null;
  const cacheKey = cacheState ? loadEvidenceCacheKey() : null;
  const results: AcceptanceGateResult[] = [];
  try {
    return await worktreeScope.run(scope, async () => {
      for (let i = 0; i < snapshot.length; i++) {
        const gate = snapshot[i]!;
        const startMs = Date.now();
        try {
          execution?.assertActive();
          execution?.consume({
            items: 1,
            bytes: gate.kind === 'manual' ? 0 : maxOutputBytes,
          });
          assertGateActive(batch);
          const parsed = acceptanceGateSchema.parse(gate);
          if (!isDeepStrictEqual(parsed, gate))
            throw new Error('Gate includes unsupported or noncanonical fields');
          if (cacheState && cacheKey && (cacheMode === 'use' || cacheMode === 'only')) {
            const lookup = readGateCacheEntry(
              projectRoot,
              parsed,
              cacheState,
              cacheInputsHash!,
              cacheKey,
            );
            if (lookup.status === 'hit') {
              // Re-dated to now (the reuse is this run's check; a bound result
              // may not precede its input capture) and marked, never disguised.
              results.push({
                ...lookup.observation,
                index: i,
                checkedAt: new Date().toISOString(),
                source: 'cache',
                cachedAt: lookup.createdAt,
              });
              continue;
            }
            // `use` treats an unauthenticated entry as a miss and overwrites it.
            if (lookup.status === 'invalid' && cacheMode === 'only')
              throw new Error(
                `${GATE_CACHE_INVALID_PREFIX} gate "${parsed.req ?? parsed.description}": ${lookup.reason}. ` +
                  'It was not used. Run `cleo verify <taskId> --run` (a pass replaces the entry), or pass --run-typed on this write',
              );
          }
          if (cacheMode === 'only' && TOOL_GATE_KINDS.has(parsed.kind)) {
            // T13693: say which key part moved since the last stored pass.
            const why =
              cacheState && cacheKey
                ? describeGateCacheMiss(
                    projectRoot,
                    parsed,
                    cacheState,
                    cacheInputsHash!,
                    options.cacheInputs,
                  )
                : null;
            throw new Error(
              `${gateNotCachedMessage(parsed, cacheState !== null, cacheKey !== null)}${why ? ` ${why}` : ''}`,
            );
          }
          const observed: AcceptanceGateResult = {
            ...(await runOneGate(
              parsed,
              i,
              treeRoot,
              options.skipManual ?? true,
              batch,
              projectRoot,
            )),
            source: 'executed',
          };
          if (cacheState && cacheKey && cacheMode !== 'only')
            writeExecutedGatePass(
              projectRoot,
              parsed,
              cacheState,
              cacheInputsHash!,
              observed,
              cacheKey,
              options.cacheInputs,
            );
          results.push(observed);
        } catch (error) {
          results.push(
            makeResult(
              i,
              gate,
              'error',
              Date.now() - startMs,
              undefined,
              error instanceof Error ? error.message : String(error),
            ),
          );
        }
      }
      return results.map((result) => ({ ...result, checkedBy }));
    });
  } finally {
    deregister();
  }
}

/**
 * `git` read in `cwd`; `null` on a non-zero exit or when git is unavailable.
 * Ambient `GIT_DIR`/`GIT_WORK_TREE` are dropped (T13695): the tree is resolved
 * explicitly ({@link resolveTypedGateRoot}), so an inherited repo pointer may
 * only ever make it read another repository.
 */
function gitOut(cwd: string, args: readonly string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      env: discoveryEnv(),
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/** Digest of a gate's inputs with every path made relative to `tree` (T12625). */
function treeInputsHash(
  tree: string,
  invocation: AcceptanceGateInvocation | undefined,
  artifacts: readonly AcceptanceGateArtifact[],
): string {
  const rel = (path: string): string => relative(tree, path) || '.';
  return createHash('sha256')
    .update(
      JSON.stringify({
        invocation: invocation ? { ...invocation, cwd: rel(invocation.cwd) } : null,
        artifacts: artifacts.map((a) => ({ ...a, path: rel(a.path) })),
      }),
    )
    .digest('hex');
}

/**
 * Content binding for a result verified in `tree`, or `undefined` when the tree
 * is not a git checkout (the result then keeps exact path-bound revalidation).
 */
function captureTreeBinding(
  tree: string,
  invocation: AcceptanceGateInvocation | undefined,
  artifacts: readonly AcceptanceGateArtifact[],
): AcceptanceGateTreeBinding | undefined {
  const headSha = gitOut(tree, ['rev-parse', 'HEAD']);
  if (headSha === null || !/^[0-9a-f]{40}$/.test(headSha)) return undefined;
  const dirty = gitOut(tree, ['status', '--porcelain', '--untracked-files=no']);
  const base = originDefault(tree);
  const baseSha = base ? gitOut(tree, ['merge-base', base, headSha]) : null;
  return {
    headSha,
    clean: dirty === '',
    cwd: invocation ? relative(tree, invocation.cwd) || '.' : '.',
    inputsHash: treeInputsHash(tree, invocation, artifacts),
    ...(baseSha && /^[0-9a-f]{40}$/.test(baseSha) ? { baseSha } : {}),
  };
}

/** `origin/<default>` from `origin/HEAD`, else origin/main or origin/master. */
function originDefault(tree: string): string | null {
  const symbolic = gitOut(tree, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  if (symbolic) return symbolic.replace(/^refs\/remotes\//, '');
  for (const ref of ['origin/main', 'origin/master']) {
    if (gitOut(tree, ['rev-parse', '--verify', '--quiet', `refs/remotes/${ref}`]) !== null)
      return ref;
  }
  return null;
}

/**
 * A typed result was verified in another tree of this project and cannot be
 * accepted from the completing tree. Carries the exact re-verify command.
 *
 * @task T12625
 */
export class TypedRevalidationError extends Error {
  /** The command that re-verifies the task's typed gates in the completing tree. */
  readonly fix: string;

  constructor(message: string, fix: string) {
    super(message);
    this.name = 'TypedRevalidationError';
    this.fix = fix;
  }
}

/** Exact command that re-records testsPassed (re-running typed gates) in `tree`. */
function reverifyCommand(task: Task, tree: string): string {
  const atoms = (task.verification?.evidence?.testsPassed?.atoms ?? []).flatMap((atom) => {
    switch (atom.kind) {
      case 'tool':
        return [`tool:${atom.tool}`];
      case 'test-run':
        return [`test-run:${atom.path}`];
      case 'satisfies':
        return [
          `satisfies:${atom.targetTaskId}#${atom.targetAcAlias ?? atom.resolvedAcUuid ?? ''}`,
        ];
      default:
        return [];
    }
  });
  const evidence = atoms.length > 0 ? atoms.join(';') : 'tool:test';
  return `cd '${tree.replace(/'/g, `'\\''`)}' && cleo verify ${task.id} --gate testsPassed --evidence '${evidence}'`;
}

/**
 * Accept a result bound in ANOTHER tree of this project (T12625): the verified
 * tree was clean, its HEAD is an ancestor of the completing HEAD (the verified
 * commit has been merged here), and the inputs recompute to the same
 * tree-relative digest. The recorded tree itself is never entered — worktrees
 * are auto-cleaned after merge.
 */
function assertTreeEquivalent(
  task: Task,
  gateLabel: string,
  bound: AcceptanceGateTreeBinding,
  tree: string,
  projectRoot: string,
  invocation: AcceptanceGateInvocation | undefined,
  artifacts: readonly AcceptanceGateArtifact[],
): void {
  const fix = reverifyCommand(task, tree);
  const real = (p: string): string => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  if (real(resolveCanonicalProjectRoot(tree)) !== real(projectRoot))
    throw new TypedRevalidationError(
      `Typed requirement ${gateLabel}: ${tree} is not a checkout of this project`,
      fix,
    );
  if (!bound.clean)
    throw new TypedRevalidationError(
      `Typed requirement ${gateLabel} was verified on a dirty tree at ${bound.headSha.slice(0, 12)}; its result cannot be carried to ${tree}`,
      fix,
    );
  if (gitOut(tree, ['merge-base', '--is-ancestor', bound.headSha, 'HEAD']) === null)
    throw new TypedRevalidationError(
      `Typed requirement ${gateLabel} was verified at ${bound.headSha.slice(0, 12)}, which is not in ${tree}'s HEAD — merge the verified commit first, or re-verify here`,
      fix,
    );
  if (treeInputsHash(tree, invocation, artifacts) !== bound.inputsHash)
    throw new TypedRevalidationError(
      `Typed requirement ${gateLabel} inputs changed since verification (${tree})`,
      fix,
    );
  // Round 3: the merge being an ancestor proves the change ARRIVED, not that it
  // is still there — a later revert leaves the ancestry and the declared gate
  // inputs intact. Every path the verified change touched must still hold the
  // verified bytes here. Without a recorded fork point the change set is
  // unknown, so the result is not carried across trees at all.
  if (!bound.baseSha)
    throw new TypedRevalidationError(
      `Typed requirement ${gateLabel} has no recorded fork point, so the verified change cannot be compared in ${tree}`,
      fix,
    );
  // --no-renames: a rename is listed as the old path's deletion AND the new
  // path's addition, so a renamed-away path later re-added here is caught.
  const changed = gitOut(tree, [
    'diff',
    '--name-only',
    '--no-renames',
    bound.baseSha,
    bound.headSha,
  ]);
  if (changed === null)
    throw new TypedRevalidationError(
      `Typed requirement ${gateLabel}: cannot read the verified change ${bound.baseSha.slice(0, 12)}..${bound.headSha.slice(0, 12)} in ${tree}`,
      fix,
    );
  const paths = changed.split('\n').filter(Boolean);
  if (paths.length > 0) {
    const drift = gitOut(tree, [
      'diff',
      '--name-only',
      '--no-renames',
      bound.headSha,
      'HEAD',
      '--',
      ...paths,
    ]);
    if (drift === null || drift !== '')
      throw new TypedRevalidationError(
        `Typed requirement ${gateLabel}: the verified change was changed on ${tree} since verification: ${(drift ?? 'unreadable').split('\n').join(', ')}`,
        fix,
      );
  }
}

/**
 * Run task requirements with their canonical AC and bounded input snapshots.
 * @param task - Captured task, including its complete mixed acceptance array.
 * @param criteria - Current normalized acceptance rows from the same task snapshot.
 * @param options - Existing explicitly admitted verification lifetime and process limits.
 * @returns Results bound to original mixed-array indexes, identities and input bytes.
 * @remarks This function never writes a result. The canonical verifier must compare
 * task/criterion freshness again and persist results plus receipt in one transaction.
 * Untracked harnesses are included; undeclared runtime dependencies are not inferred.
 * @example
 * ```typescript
 * const results = await runTaskGates(task, rows, { projectRoot, execution });
 * ```
 */
export async function runTaskGates(
  task: Task,
  criteria: readonly AcRow[],
  options: RunGatesOptions,
): Promise<AcceptanceGateResult[]> {
  const execution = options.execution ?? worktreeScope.getStore()?.execution;
  if (!execution || execution.identity.operation !== 'check.gate.verify')
    throw new Error(
      'Typed verification requires an explicitly admitted check.gate.verify lifetime',
    );
  const root = resolve(options.projectRoot ?? execution.identity.projectRoot);
  const scope = captureProjectScope(root, {
    ...captureProjectScope(root, worktreeScope.getStore()),
    execution,
  });
  const snapshot = structuredClone(task);
  const rows = structuredClone([...criteria]).sort((a, b) => a.ordinal - b.ordinal);
  assertCriterionProjection(snapshot, rows);
  const env = { ...(options.env ?? process.env) };
  const verificationId = randomUUID();
  const tree = resolveTypedGateRoot(root);
  return worktreeScope.run(scope, async () => {
    const results: AcceptanceGateResult[] = [];
    for (const [index, gate] of (snapshot.acceptance ?? []).entries()) {
      if (typeof gate === 'string') continue;
      execution.assertActive();
      const capturedAt = new Date().toISOString();
      // T12718 review: a gate whose command is refused (shell syntax, open
      // quote) becomes ITS OWN `error` result. Throwing here rejected the whole
      // batch, and the verify engine turned that into E_GENERAL, discarding
      // every other gate's verdict.
      const { invocation, refusal: invocationRefusal } = resolveInvocation(gate, tree, env);
      // T13527: an input that cannot be captured (an ambiguous symlink, an
      // escape) is THIS gate's error, not a rejection of every gate in the
      // batch. A cancellation still propagates.
      let artifacts: AcceptanceGateArtifact[] = [];
      let snapshotRefusal: string | undefined;
      try {
        artifacts = await snapshotGateInputs(snapshot, gate, invocation, execution, tree);
      } catch (error) {
        execution.assertActive();
        snapshotRefusal = `Typed gate inputs could not be captured: ${error instanceof Error ? error.message : String(error)}`;
      }
      const refusal = invocationRefusal ?? snapshotRefusal;
      const binding: AcceptanceGateBinding = {
        version: 1,
        verificationId,
        identity: { ...execution.identity },
        taskId: snapshot.id,
        criterionId: rows[index]!.id,
        criterionHash: acTextHash(rows[index]!.text),
        gateHash: createHash('sha256').update(acItemToText(gate)).digest('hex'),
        capturedAt,
        deadlineAt: execution.deadlineAt,
        ...(invocation ? { invocation } : {}),
        artifacts,
      };
      const treeBinding = captureTreeBinding(tree, invocation, artifacts);
      if (treeBinding) binding.tree = treeBinding;
      const observed = refusal
        ? {
            ...makeResult(index, gate, 'error', 0, undefined, refusal),
            checkedBy: execution.identity.actor,
          }
        : (
            await runGates([gate], {
              ...options,
              projectRoot: root,
              env,
              execution,
              ...(options.cache && options.cache !== 'off'
                ? {
                    cacheInputsHash: gateInputsHash(invocation, artifacts),
                    cacheInputs: {
                      environmentHash: invocation?.environmentHash ?? null,
                      artifacts,
                    },
                  }
                : {}),
            })
          )[0]!;
      let result: AcceptanceGateResult = { ...observed, index, binding };
      // T13525: a cache-only run must not wipe a stored pass that still proves
      // this exact gate on these exact inputs (a commit moved HEAD, which keys
      // the cache, but changed nothing the gate reads).
      if (result.errorMessage?.startsWith(GATE_NOT_CACHED_PREFIX)) {
        const reused = reusableStoredPass(options.priorResults, index, gate, binding);
        if (reused) result = reused;
      }
      try {
        // A gate whose inputs were never captured has nothing to compare.
        const after = snapshotRefusal
          ? artifacts
          : await snapshotGateInputs(snapshot, gate, invocation, execution, tree);
        if (!isDeepStrictEqual(after, artifacts))
          throw new Error('Verification inputs changed during execution');
      } catch (error) {
        result = {
          ...result,
          result: 'error',
          errorMessage: error instanceof Error ? error.message : String(error),
        };
      }
      results.push(acceptanceGateResultSchema.parse(result));
    }
    return results;
  });
}

/**
 * The stored pass for `index`, re-bound to this run, when it proves the same
 * thing a cache entry would: same gate kind and REQ-ID, criterion id and text
 * hash, gate definition hash, invocation and input bytes (T13525). Marked
 * `source: 'cache'` with the original capture time, like a cache hit.
 */
function reusableStoredPass(
  prior: readonly AcceptanceGateResult[] | undefined,
  index: number,
  gate: AcceptanceGate,
  binding: AcceptanceGateBinding,
): AcceptanceGateResult | null {
  const stored = prior?.find((r) => r.index === index);
  const was = stored?.binding;
  if (
    !stored ||
    !was ||
    stored.result !== 'pass' ||
    stored.kind !== gate.kind ||
    stored.req !== gate.req ||
    was.taskId !== binding.taskId ||
    was.criterionId !== binding.criterionId ||
    was.criterionHash !== binding.criterionHash ||
    was.gateHash !== binding.gateHash ||
    !isDeepStrictEqual(was.invocation, binding.invocation) ||
    !isDeepStrictEqual(was.artifacts, binding.artifacts)
  )
    return null;
  const { binding: _old, source: _source, cachedAt: _cachedAt, ...observation } = stored;
  // Re-dated to now, as a cache hit is: a bound result may not precede its capture.
  return {
    ...observation,
    index,
    binding,
    checkedAt: new Date().toISOString(),
    source: 'cache',
    cachedAt: was.capturedAt,
  };
}

/**
 * Build the existing audit detail payload for one validated typed-result batch.
 * @param results - Exact result array that is persisted alongside this receipt.
 * @param passed - Overall verification outcome at the time of recording.
 * @returns The canonical receipt detail shape with deterministic result-byte hash.
 * @throws Error when results are absent, unbound, duplicated or belong to different batches.
 * @remarks This serializer establishes shape and byte identity, not execution authority.
 * The caller must persist the receipt and results in the same owning transaction.
 * @example
 * ```ts
 * const details = createTaskGateReceipt(results, verification.passed);
 * await transaction.appendLog({ action: 'gate.verify.typed', taskId, details });
 * ```
 */
export function createTaskGateReceipt(
  results: readonly AcceptanceGateResult[],
  passed: boolean,
): AcceptanceGateVerificationReceipt {
  const first = results[0]?.binding;
  if (!first) throw new Error('Typed receipt requires a bound result batch');
  const indexes = new Set<number>();
  const criteria = new Set<string>();
  for (const candidate of results) {
    const result = acceptanceGateResultSchema.parse(candidate);
    const binding = result.binding;
    if (
      !binding ||
      binding.verificationId !== first.verificationId ||
      binding.taskId !== first.taskId ||
      !isDeepStrictEqual(binding.identity, first.identity) ||
      binding.deadlineAt !== first.deadlineAt ||
      indexes.has(result.index) ||
      criteria.has(binding.criterionId)
    )
      throw new Error('Typed receipt requires one batch owner and unique criterion results');
    indexes.add(result.index);
    criteria.add(binding.criterionId);
  }
  const cached = results
    .filter((result) => result.source === 'cache')
    .map((result) => ({ index: result.index, cachedAt: result.cachedAt! }));
  return {
    verificationId: first.verificationId,
    resultHash: createHash('sha256').update(JSON.stringify(results)).digest('hex'),
    operation: 'check.gate.verify',
    passed,
    // T12621: omitted when nothing was reused, so earlier receipts still match.
    ...(cached.length > 0 ? { cached } : {}),
  };
}

/**
 * Why a stored typed result no longer stands for `gate` on `task`, or null
 * when its result, kind, REQ-ID and binding (task, owner, criterion id,
 * criterion text hash, gate definition hash) all match. The one predicate
 * `cleo complete`'s revalidation and `cleo done --plan` share (T13502), so
 * the plan never reads as a pass what completion refuses.
 *
 * @param result - The stored typed result for the gate's index.
 * @param task - The task (its id).
 * @param gate - The gate at that index now.
 * @param row - The AC row at that index now.
 * @param owner - The project identity and root completing; omitted, the owner is not compared.
 * @param requirePassing - True when only a pass may stand (completion, planning).
 * @returns The reason, worded to follow "Typed requirement <id> ", or null.
 * @task T13502
 */
export function typedResultStaleReason(
  result: AcceptanceGateResult,
  task: Pick<Task, 'id'>,
  gate: AcceptanceGate,
  row: Pick<AcRow, 'id' | 'text'>,
  owner?: { projectId: string; projectRoot: string },
  requirePassing = true,
): string | null {
  const binding = result.binding;
  if (
    (requirePassing && result.result !== 'pass') ||
    !binding ||
    result.kind !== gate.kind ||
    result.req !== gate.req
  )
    return 'lacks a passing bound result';
  if (
    binding.taskId !== task.id ||
    (owner !== undefined &&
      (binding.identity.projectId !== owner.projectId ||
        binding.identity.projectRoot !== owner.projectRoot)) ||
    binding.criterionId !== row.id ||
    binding.criterionHash !== acTextHash(row.text) ||
    binding.gateHash !== createHash('sha256').update(acItemToText(gate)).digest('hex')
  )
    return 'binding is stale or belongs to another owner';
  return null;
}

/**
 * Revalidate persisted typed results against current canonical task and input state.
 * @param task - Current task read under the caller's transaction ownership.
 * @param criteria - Current normalized AC rows from that transaction.
 * @param results - Authentic stored results, never caller-submitted verdicts.
 * @param options - Current captured lifetime bounding revalidation work.
 * @param requirePassing - True for completion; false only when recording actual unmet verification outcomes.
 * @returns Resolves when bound inputs are current and the requested verdict policy holds.
 * @remarks Historical unbound results and generic text-AC evidence cannot substitute.
 * Filesystem checks are cooperative and cannot make external file writes atomic with SQLite.
 * @example
 * ```typescript
 * await revalidateTaskGateResults(task, rows, task.verification?.gateResults ?? [], { execution });
 * ```
 */
export async function revalidateTaskGateResults(
  task: Task,
  criteria: readonly AcRow[],
  results: readonly AcceptanceGateResult[],
  options: RunGatesOptions,
  requirePassing = true,
): Promise<void> {
  const execution = options.execution ?? worktreeScope.getStore()?.execution;
  if (!execution)
    throw new Error('Typed result revalidation requires a captured execution lifetime');
  const root = resolve(options.projectRoot ?? execution.identity.projectRoot);
  const scope = captureProjectScope(root, {
    ...captureProjectScope(root, worktreeScope.getStore()),
    execution,
  });
  const rows = [...criteria].sort((a, b) => a.ordinal - b.ordinal);
  assertCriterionProjection(task, rows);
  const env = { ...(options.env ?? process.env) };
  const tree = resolveTypedGateRoot(root);
  await worktreeScope.run(scope, async () => {
    for (const [index, gate] of (task.acceptance ?? []).entries()) {
      if (typeof gate === 'string' || (requirePassing && gate.advisory)) continue;
      execution.assertActive();
      const matches = results.filter((result) => result.index === index);
      if (matches.length !== 1)
        throw new Error(`Typed requirement ${gate.req ?? index} has no unique verified result`);
      const result = acceptanceGateResultSchema.parse(matches[0]);
      const stale = typedResultStaleReason(
        result,
        task,
        gate,
        rows[index]!,
        { projectId: execution.identity.projectId, projectRoot: root },
        requirePassing,
      );
      if (stale) throw new Error(`Typed requirement ${gate.req ?? index} ${stale}`);
      const binding = result.binding!;
      // A refused command is bound without an invocation (T12718 review), so it
      // revalidates as the unmet `error` it was recorded as.
      const { invocation } = resolveInvocation(gate, tree, env);
      // T13527: an unmet result recorded because its inputs could not be
      // captured has nothing to re-capture; completion (requirePassing) never
      // reaches here with it, because only a pass stands there.
      let artifacts: AcceptanceGateArtifact[];
      try {
        artifacts = await snapshotGateInputs(task, gate, invocation, execution, tree);
      } catch (error) {
        execution.assertActive();
        if (!requirePassing && result.result !== 'pass') continue;
        throw error;
      }
      const exact =
        isDeepStrictEqual(binding.invocation, invocation) &&
        isDeepStrictEqual(binding.artifacts, artifacts);
      if (exact) continue;
      // T12625: a result bound in another tree of this project (a worker's
      // worktree) is accepted by CONTENT, not by path. Pre-T12625 receipts carry
      // no tree binding and keep the exact path-bound refusals below.
      if (binding.tree) {
        assertTreeEquivalent(
          task,
          gate.req ?? String(index),
          binding.tree,
          tree,
          root,
          invocation,
          artifacts,
        );
        continue;
      }
      if (!isDeepStrictEqual(binding.invocation, invocation))
        throw new Error(`Typed requirement ${gate.req ?? index} invocation or environment changed`);
      throw new Error(
        `Typed requirement ${gate.req ?? index} input bytes changed after verification`,
      );
    }
  });
}

/**
 * Validate completion authority from current typed inputs and the canonical verification receipt.
 * @param task - Task snapshot owned by the caller's write transaction.
 * @param criteria - Normalized criteria from that same transaction.
 * @param options - Captured original execution lifetime and project scope.
 * @param accessor - Canonical receipt reader bound to the same project store.
 * @param policy - Project evidence policy; `allowCachedGates: false` refuses cached passes (T12621).
 * @returns Resolves only when every hard typed requirement has current authentic proof.
 * @throws When typed representations, results, inputs or canonical receipts disagree.
 * @remarks Callers retain transaction ownership and must check their execution context before
 * committing. Advisory gates retain their existing semantics; generic evidence cannot replace
 * hard typed proof. Filesystem hashing is cooperative, not atomic with external file writes.
 * @example
 * ```typescript
 * await validateTaskGateCompletion(task, rows, { execution }, accessor);
 * ```
 */
export async function validateTaskGateCompletion(
  task: Task,
  criteria: readonly AcRow[],
  options: RunGatesOptions,
  accessor: Pick<DataAccessor, 'queryAuditLog'>,
  policy: { allowCachedGates?: boolean } = {},
): Promise<void> {
  const results = task.verification?.gateResults ?? [];
  // T12621: `evidence.allowCachedGates: false` — a hard typed requirement must
  // have been executed, not reused from the evidence cache.
  if (policy.allowCachedGates === false) {
    for (const [index, gate] of (task.acceptance ?? []).entries()) {
      if (typeof gate === 'string' || gate.advisory) continue;
      const reused = results.find((result) => result.index === index && result.source === 'cache');
      if (reused)
        throw new Error(
          `Typed requirement ${gate.req ?? index} passed from the evidence cache (cached ${reused.cachedAt}) ` +
            'and this project sets evidence.allowCachedGates to false; re-verify so the gate executes',
        );
    }
  }
  await revalidateTaskGateResults(task, criteria, results, options);
  if (!(task.acceptance ?? []).some((item) => typeof item !== 'string' && !item.advisory)) return;
  const passingDetails = JSON.stringify(createTaskGateReceipt(results, true));
  const failingDetails = JSON.stringify(createTaskGateReceipt(results, false));
  const receipts = await accessor.queryAuditLog({
    taskIds: [task.id],
    actions: ['gate.verify.typed'],
    limit: 100,
  });
  if (
    !receipts.some(
      (receipt) =>
        receipt.actor === results[0]!.binding!.identity.actor &&
        (receipt.detailsJson === passingDetails || receipt.detailsJson === failingDetails),
    )
  )
    throw new Error('Typed requirement result has no authentic matching canonical receipt');
  (options.execution ?? worktreeScope.getStore()?.execution)?.assertActive();
}

/** Require the stored mixed acceptance array and ordered normalized rows to agree. */
function assertCriterionProjection(task: Task, rows: readonly AcRow[]): void {
  const acceptance = task.acceptance ?? [];
  if (
    rows.length !== acceptance.length ||
    rows.some(
      (row, index) =>
        row.taskId !== task.id ||
        row.text !== acItemToText(acceptance[index]!) ||
        (row.kind === 'evidence_bound') !== (typeof acceptance[index] !== 'string') ||
        (row.kind !== 'child_task' &&
          row.contentHash !== null &&
          row.contentHash !== acTextHash(row.text)),
    )
  )
    throw new Error(
      'Typed verification refused inconsistent acceptance JSON and normalized AC rows',
    );
}

/** Effective child environment shared by launch and verification input hashing. */
function gateEnvironment(
  env: NodeJS.ProcessEnv,
  overlay?: Readonly<Record<string, string>>,
): NodeJS.ProcessEnv {
  const merged = { ...env, ...overlay };
  return { ...merged, ...heavyToolEnv('test', merged) };
}

/**
 * Resolve the actual executable inputs once using the same rules as process
 * launch. Exported so `cleo goal draft` spells a gate's command exactly as it
 * runs (T13793).
 *
 * @param gate - The gate.
 * @param root - Project root its `cwd` resolves against.
 * @param env - Environment the gate's `env` overlays.
 * @returns The invocation, or undefined for a gate that runs no process.
 */
export function executableInvocation(
  gate: AcceptanceGate,
  root: string,
  env: NodeJS.ProcessEnv,
): AcceptanceGateInvocation | undefined {
  if (gate.kind !== 'test' && gate.kind !== 'command' && gate.kind !== 'lint') return undefined;
  // T12718: quoted words are honoured and shell syntax is refused. A plain
  // whitespace split handed `"` characters to the target, so
  // `node -e "setTimeout(()=>process.exit(1),6000)"` evaluated a string
  // literal, exited 0 at once and recorded a false PASS.
  const [testCommand, ...testArgs] = gate.kind === 'test' ? splitCommandLine(gate.command) : [];
  if (gate.kind === 'test' && testCommand === undefined)
    throw new Error('Test gate command is empty');
  const command =
    gate.kind === 'test'
      ? testCommand!
      : gate.kind === 'command'
        ? gate.cmd
        : LINT_TOOL_DEFAULTS[gate.tool].cmd;
  const args =
    gate.args ??
    (gate.kind === 'test'
      ? testArgs
      : gate.kind === 'lint'
        ? LINT_TOOL_DEFAULTS[gate.tool].defaultArgs
        : []);
  const effective = gateEnvironment(env, gate.kind === 'lint' ? undefined : gate.env);
  return {
    command,
    args: [...args],
    cwd: resolveCwd(root, gate.cwd),
    environmentHash: createHash('sha256')
      .update(
        JSON.stringify(
          Object.entries(effective)
            .filter(([, value]) => value !== undefined)
            .sort(([a], [b]) => a.localeCompare(b)),
        ),
      )
      .digest('hex'),
  };
}

/**
 * Resolve a gate's invocation, turning a refused command line into a message.
 *
 * `executableInvocation` throws when a test gate's `command` cannot be split
 * (shell syntax, unterminated quote, empty). Batch callers need that as one
 * gate's `error` verdict, not as a rejection of every gate (T12718 review).
 */
function resolveInvocation(
  gate: AcceptanceGate,
  root: string,
  env: NodeJS.ProcessEnv,
): { invocation: AcceptanceGateInvocation | undefined; refusal?: string } {
  try {
    return { invocation: executableInvocation(gate, root, env) };
  } catch (error) {
    return {
      invocation: undefined,
      refusal: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * T13527: an interpreter script reached through a package manager's
 * `node_modules` link (pnpm resolves `node_modules/vitest` to
 * `node_modules/.pnpm/vitest@x/node_modules/vitest`) is captured at its real
 * path, so the ambiguous-parent guard below sees a plain path inside the
 * project. Only a link that resolves into this project's `.pnpm` virtual store
 * is followed; any other link is left for the guard to refuse.
 */
async function packageStoreRealPath(root: string, path: string): Promise<string> {
  const rel = relative(root, path).split('\\').join('/');
  if (!/(^|\/)node_modules\//.test(rel)) return path;
  try {
    const real = await realpath(path);
    const realRel = relative(root, real).split('\\').join('/');
    if (
      realRel !== '' &&
      !realRel.startsWith('../') &&
      !isAbsolute(realRel) &&
      /(^|\/)node_modules\/\.pnpm\//.test(realRel)
    )
      return real;
  } catch {
    // absent or unreadable: the guard below decides
  }
  return path;
}

/** bun subcommands: the word after `bun` that is not a script (T13566). */
const BUN_SUBCOMMANDS: ReadonlySet<string> = new Set(['test', 'run', 'x', 'exec', 'build']);

/**
 * bun options whose value names a file that changes what the gate runs (a
 * preload, env file, bunfig, tsconfig): never the script, but captured as an
 * input when it names an existing file, so editing it invalidates a cached
 * pass (T13574 review).
 */
const BUN_FILE_FLAGS: ReadonlySet<string> = new Set([
  '-c',
  '--config',
  '-r',
  '--preload',
  '--env-file',
  '--tsconfig-override',
]);

/** bun options whose next argument is their value, never a script or a positional (T13574). */
const BUN_VALUE_FLAGS: ReadonlySet<string> = new Set([...BUN_FILE_FLAGS, '--cwd']);

/** Flags that make an interpreter evaluate inline code, so it runs no script file. */
function evalFlags(command: string): readonly string[] {
  // bun's `-c` is `--config` (T13574); for python, bash and sh it is inline code.
  return command === 'bun' || command === 'bunx'
    ? ['-e', '--eval', '-p', '--print']
    : ['-e', '--eval', '-c', '--print', '-p'];
}

/**
 * The script an interpreter invocation runs, the argument indexes that are
 * never inputs, and the directory its file arguments resolve from (T13566,
 * T13574). The first positional argument is the script — `node a.js` — with
 * bun's exceptions:
 *  - a subcommand (`bun test a.test.ts b.test.ts`, `bun run file.ts`) leaves no
 *    implicit script; the named files are captured as file-like arguments, and
 *    the package `bun x <pkg>` / `bunx <pkg>` runs is not a project file;
 *  - otherwise the first positional is the script only when it is an existing
 *    regular file (`bun a.ts`); any other word (`install`, `add`, `pm`,
 *    `create`, …) is a subcommand whose arguments name packages, not inputs;
 *  - the values of bun's value flags (`-c bunfig.toml`, `--cwd dir`) are never
 *    the script; a file flag's value (`--preload ./setup.ts`, `--env-file`,
 *    `-c`, `--tsconfig-override`) is returned as an input when it names an
 *    existing regular file, and `--cwd` moves where file arguments resolve.
 *
 * @param command - Basename of the interpreter.
 * @param args - Its arguments.
 * @param cwd - The invocation's working directory.
 * @returns The implicit script, the indexes to leave out, the resolution base,
 *   and the absolute paths of files named by bun's file flags.
 */
async function interpreterScript(
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<{
  script: string | undefined;
  notInputs: ReadonlySet<number>;
  base: string;
  flagFiles: readonly string[];
}> {
  const bun = command === 'bun' || command === 'bunx';
  const notInputs = new Set<number>();
  let base = cwd;
  const flagValues: string[] = [];
  if (bun) {
    args.forEach((arg, index) => {
      const eq = arg.indexOf('=');
      const flag = arg.startsWith('--') && eq > 0 ? arg.slice(0, eq) : arg;
      const inline = flag === arg ? undefined : arg.slice(eq + 1);
      if (!BUN_VALUE_FLAGS.has(flag)) return;
      const value = inline ?? args[index + 1];
      if (value === undefined) return;
      if (inline === undefined) notInputs.add(index + 1);
      if (flag === '--cwd') base = resolve(cwd, value);
      else flagValues.push(value);
    });
  }
  const regularFile = (path: string): Promise<boolean> =>
    stat(path).then(
      (st) => st.isFile(),
      () => false,
    );
  const flagFiles: string[] = [];
  for (const value of flagValues) {
    const path = resolve(base, value);
    if (await regularFile(path)) flagFiles.push(path);
  }
  const positional = args.flatMap((arg, index) =>
    arg.startsWith('-') || notInputs.has(index) ? [] : [index],
  );
  const word = (n: number): string | undefined => {
    const index = positional[n];
    return index === undefined ? undefined : args[index];
  };
  const exclude = (n: number): void => {
    const index = positional[n];
    if (index !== undefined) notInputs.add(index);
  };
  if (command === 'bunx') {
    exclude(0);
    return { script: undefined, notInputs, base, flagFiles };
  }
  if (command !== 'bun') return { script: word(0), notInputs, base, flagFiles };
  const first = word(0);
  if (first !== undefined && BUN_SUBCOMMANDS.has(first)) {
    exclude(0);
    if (first === 'x') exclude(1);
    return { script: undefined, notInputs, base, flagFiles };
  }
  if (first !== undefined && (await regularFile(resolve(base, first))))
    return { script: first, notInputs, base, flagFiles };
  for (const index of positional) notInputs.add(index);
  return { script: undefined, notInputs, base, flagFiles };
}

/** Capture declared task inputs and an interpreter's explicit harness argument. */
async function snapshotGateInputs(
  task: Task,
  gate: AcceptanceGate,
  invocation: AcceptanceGateInvocation | undefined,
  execution: OperationExecutionContext,
  /** T12625: the tree the gate runs in ({@link resolveTypedGateRoot}). */
  treeRoot: string = resolve(execution.identity.projectRoot),
): Promise<AcceptanceGateArtifact[]> {
  const root = resolve(treeRoot);
  if (invocation) {
    const cwdRelative = relative(root, invocation.cwd);
    if (cwdRelative === '..' || cwdRelative.startsWith('../') || isAbsolute(cwdRelative))
      throw new Error('Typed invocation working directory escapes the captured project');
    if ((await realpath(invocation.cwd)) !== invocation.cwd)
      throw new Error('Typed invocation working directory has ambiguous symlink ownership');
  }
  const paths = new Set((task.files ?? []).map((path) => resolve(root, path)));
  // T13690: a declared task file is a literal path; `app/[id]/page.tsx` is a
  // Next.js route, not a glob. Only paths from other sources are refused.
  const literal = new Set(paths);
  if (gate.kind === 'file' && gate.path) paths.add(resolve(root, gate.path));
  if (
    invocation &&
    /^(node(?:\.exe)?|python[0-9.]*(?:\.exe)?|bun|bunx|deno|tsx|ts-node|bash|sh|ruby|perl)$/.test(
      basename(invocation.command),
    )
  ) {
    const command = basename(invocation.command);
    if (!invocation.args.some((arg) => evalFlags(command).includes(arg))) {
      const scripts: string[] = [];
      const { script, notInputs, base, flagFiles } = await interpreterScript(
        command,
        invocation.args,
        invocation.cwd,
      );
      if (script) scripts.push(resolve(base, script));
      scripts.push(...flagFiles);
      invocation.args.forEach((arg, index) => {
        if (
          !notInputs.has(index) &&
          !arg.startsWith('-') &&
          (arg.includes('/') || /\.(?:[cm]?[jt]sx?|py|sh|rb|pl)$/.test(arg))
        )
          scripts.push(resolve(base, arg));
      });
      for (const path of scripts) paths.add(await packageStoreRealPath(root, path));
    }
  }
  const artifacts: AcceptanceGateArtifact[] = [];
  for (const path of [...paths].sort()) {
    execution.assertActive();
    execution.consume({ items: 1 });
    const globLike = /[?*[\]{}]/.test(path);
    if (!literal.has(path) && globLike)
      throw new Error(`Typed input requires an explicit file path: ${path}`);
    const rel = relative(root, path);
    if (!rel || rel === '..' || rel.startsWith('../') || isAbsolute(rel))
      throw new Error(`Typed input escapes the captured project: ${path}`);
    // Refuse redirected parents even for absent files; absence must belong to this project.
    let parent = dirname(path);
    for (;;) {
      try {
        if ((await realpath(parent)) !== parent)
          throw new Error(`Typed input has an ambiguous symlink parent: ${path}`);
        break;
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
        if (parent === root) throw error;
        parent = dirname(parent);
      }
    }
    let before: Stats;
    try {
      before = await lstat(path);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        // T13691: an absent glob-looking entry is a pattern written by mistake
        // (task.files are literal); recorded absent, its hash would never move.
        if (globLike)
          // @sync-invariant none:input-shape a declared task path that is a mistaken glob is refused before the gate runs; nothing is written
          throw new Error(
            `declared task file ${relative(root, path)} does not exist; list explicit paths, task.files are literal`,
          );
        artifacts.push({ path, sha256: null, bytes: null });
        continue;
      }
      throw error;
    }
    if (!before.isFile() || before.isSymbolicLink())
      throw new Error(`Typed input is not an unambiguous regular file: ${path}`);
    const ceiling = execution.resources.maxBytes ?? 1_048_576;
    if (before.size > ceiling) throw new Error(`Typed input exceeds admitted byte limit: ${path}`);
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await file.stat();
      if (opened.dev !== before.dev || opened.ino !== before.ino)
        throw new Error(`Typed input replaced while opening: ${path}`);
      const hash = createHash('sha256');
      const buffer = Buffer.alloc(65_536);
      let bytes = 0;
      for (;;) {
        execution.assertActive();
        const chunk = await file.read(buffer, 0, buffer.length, null);
        if (chunk.bytesRead === 0) break;
        bytes += chunk.bytesRead;
        if (bytes > ceiling)
          throw new Error(`Typed input grew beyond admitted byte limit: ${path}`);
        execution.consume({ bytes: chunk.bytesRead });
        hash.update(buffer.subarray(0, chunk.bytesRead));
      }
      const after = await file.stat();
      const named = await lstat(path);
      if (
        bytes !== before.size ||
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs ||
        named.dev !== before.dev ||
        named.ino !== before.ino
      )
        throw new Error(`Typed input changed while hashing: ${path}`);
      execution.assertActive();
      artifacts.push({ path, sha256: hash.digest('hex'), bytes });
    } finally {
      await file.close();
    }
  }
  return artifacts;
}

/** Check the shared boundary without pretending to preempt synchronous operations. */
function assertGateActive(context: ProcessCaptureOptions): void {
  context.execution.signal?.throwIfAborted();
  if (Date.now() >= context.execution.deadlineAt)
    throw new Error(
      'Gate did not finish: original shared deadline expired. This is NOT a failure verdict.',
    );
}

// ─── Internal dispatcher ──────────────────────────────────────────────────────

async function runOneGate(
  gate: AcceptanceGate,
  index: number,
  projectRoot: string,
  skipManual: boolean,
  context: ProcessCaptureOptions,
  /** CLEO store root for attachment lookups; defaults to `projectRoot`. */
  storeRoot: string = projectRoot,
): Promise<AcceptanceGateResult> {
  const timeout = resolveGateTimeoutMs(gate, context.env ?? process.env);

  switch (gate.kind) {
    case 'test':
      return runTestGate(gate, index, projectRoot, timeout, context);
    case 'file':
      return runFileGate(gate, index, projectRoot, context, storeRoot);
    case 'command':
      return runCommandGate(gate, index, projectRoot, timeout, context);
    case 'lint':
      return runLintGate(gate, index, projectRoot, timeout, context);
    case 'http':
      return runHttpGate(gate, index, projectRoot, timeout, context);
    case 'manual':
      return runManualGate(gate, index, skipManual);
  }
}

// ─── Test gate ────────────────────────────────────────────────────────────────

/**
 * Execute a process gate through the existing captured resource service,
 * admitted first through the machine-wide ledger (T13573).
 *
 * A typed gate is charged what `cleo run` would charge the same command
 * ({@link planRunFootprint} for its class) and waits on the same ledger and
 * pressure predicate as `cleo run` and `tool:` evidence, so a gate cannot run
 * while the budget is full. The wait ends {@link TYPED_GATE_BOOKKEEPING_MS}
 * before the shared deadline, so a refusal (the admission's own error, naming
 * the holders) is recorded as the gate's result. The child inherits the admission
 * token, so a governed command it starts is not charged twice.
 */
async function captureGateCommand(
  command: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
  cls: 'test-run' | 'scoped-build',
  context: ProcessCaptureOptions,
  overlay?: Readonly<Record<string, string>>,
): Promise<ProcessCaptureResult> {
  const env = gateEnvironment(context.env ?? process.env, overlay);
  const plan = planRunFootprint(cls, [command, ...args], env);
  // The gate spawns with the whole heavy-run env (gateEnvironment), not the
  // plan's overlay, so a worker-pool plan is charged the whole heavy run (T13759).
  const footprintBytes =
    plan.resources !== null && plan.resources.workers > 1
      ? footprintForClass(cls)
      : (plan.footprintBytes ?? footprintForClass(cls));
  const release = await acquireGlobalSlot(cls === 'test-run' ? 'test' : 'lint', {
    label: `gate:${cls === 'test-run' ? 'test' : 'command'}`,
    footprintBytes,
    // End the wait while the bookkeeping budget remains, so the refusal is recorded.
    timeoutMs: Math.max(0, context.execution.deadlineAt - Date.now() - TYPED_GATE_BOOKKEEPING_MS),
  });
  try {
    return await captureWrapped(command, args, {
      ...context,
      cwd,
      env: release.admission ? { ...env, [ADMISSION_ENV]: release.admission } : env,
      execution: {
        ...context.execution,
        deadlineAt: Math.min(context.execution.deadlineAt, Date.now() + timeoutMs),
      },
    });
  } finally {
    await release();
  }
}

/** Preserve target failure independently from launch, cancellation and cleanup failures. */
function processGateResult(
  index: number,
  gate: AcceptanceGate,
  captured: ProcessCaptureResult,
  verdict: 'pass' | 'fail' | 'error',
  reason?: string,
): AcceptanceGateResult {
  const incomplete =
    !captured.started ||
    !captured.targetCloseObserved ||
    captured.exitCode === null ||
    captured.signal !== null ||
    captured.error !== null ||
    captured.stopped !== null ||
    captured.outputTruncated ||
    captured.cleanupErrors.length > 0;
  return {
    ...makeResult(
      index,
      gate,
      incomplete ? 'error' : verdict,
      captured.durationMs,
      truncateString(`${captured.stdout}\n${captured.stderr}`.trim(), MAX_EVIDENCE_CHARS),
      incomplete
        ? `Gate did not finish: ${captured.error ?? captured.stopped ?? captured.signal ?? (captured.cleanupErrors.join('; ') || 'target outcome missing')}. This is NOT a failure verdict.`
        : reason,
    ),
    execution: captured,
  };
}

/**
 * Index of the `}` closing the `{` at `start`, or `-1`.
 *
 * String literals are tracked so a brace inside a test NAME — which reports
 * are full of — cannot terminate the object early.
 */
function matchingBrace(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return i;
  }
  return -1;
}

/** The counts a structured report (full or summary) proves. */
interface StructuredTestCounts {
  numPassedTests: number;
  numFailedTests?: number;
  success?: boolean;
}

/**
 * Structured test counts emitted by THIS gate's own process, or `null`.
 *
 * Validated with {@link testCountReportSchema} — the contract written for
 * exactly this purpose, which cross-checks every summary counter against the
 * individual assertion results, so a report cannot claim a total its own
 * details contradict.
 *
 * The whole captured stream is searched rather than requiring `stdout` to BE
 * the document, because a runner that writes a JSON report to stdout routinely
 * prefixes it with progress output. Candidates are tried newest-first, since a
 * summary is emitted after its noise.
 *
 * Provenance is the reason this reads the gate's OWN capture and nothing else:
 * a report file named by the task could have been produced by any run, of any
 * code, at any time. Only the bytes this invocation emitted are bound to it.
 *
 * A non-runner command (a wrapper script) may instead print a bare count
 * summary ({@link testCountSummarySchema}) as its last stdout line (T13753).
 *
 * @param captured - Result of running the gate command.
 * @returns Validated counts, or `null` when the run emitted no usable report.
 * @task T12308
 * @task T13753
 */
function structuredTestCounts(captured: ProcessCaptureResult): StructuredTestCounts | null {
  const lastLine = captured.stdout.trimEnd().split('\n').at(-1)?.trim() ?? '';
  if (lastLine.startsWith('{')) {
    try {
      const summary = testCountSummarySchema.safeParse(JSON.parse(lastLine));
      if (summary.success) return summary.data;
    } catch {
      // Not JSON: fall through to the full-report search.
    }
  }
  const text = `${captured.stdout}\n${captured.stderr}`.trim();
  if (text.length === 0) return null;
  const tryParse = (candidate: string): StructuredTestCounts | null => {
    try {
      const report = testCountReportSchema.safeParse(JSON.parse(candidate));
      return report.success ? report.data : null;
    } catch {
      return null;
    }
  };
  const direct = tryParse(text);
  if (direct !== null) return direct;
  // `lastIndexOf(s, -1)` searches from index 0 and returns 0 for a leading
  // brace, so decrementing past the start yields the SAME index forever. The
  // loop is synchronous, so a vitest `testTimeout` cannot interrupt it — the
  // run just dies on the job's wall clock with no failing assertion. Terminate
  // on `start === 0` explicitly rather than relying on the search to run out.
  let start = text.lastIndexOf('{');
  while (start > -1) {
    const end = matchingBrace(text, start);
    if (end !== -1) {
      const parsed = tryParse(text.slice(start, end + 1));
      if (parsed !== null) return parsed;
    }
    if (start === 0) break;
    start = text.lastIndexOf('{', start - 1);
  }
  return null;
}

/**
 * Where vitest writes `--reporter=json` when the config sets `outputFile`
 * (VidaPeps T2027: `.vitest/json/output.json`), relative to the gate's cwd.
 */
const REDIRECTED_JSON_REPORT = join('.vitest', 'json', 'output.json');

/**
 * The line vitest 5 prints after writing its JSON report to a file. With no
 * `outputFile` it writes `.vitest/json/output.json` under its own root, which
 * is the child's cwd (`pnpm --filter <pkg> exec vitest` runs in the package),
 * not the gate's (T13874).
 */
const REPORT_WRITTEN_LINE = /^JSON report written to (.+?)\s*$/gm;

/**
 * Report files the run's own output says it wrote (T13874), inside the
 * project only: a path the child names outside the project is never read.
 *
 * @param stdout - The run's captured stdout.
 * @param projectRoot - The project the gate belongs to.
 * @returns Absolute report paths, in output order.
 * @task T13874
 */
function announcedReportFiles(stdout: string, projectRoot: string): string[] {
  return [...stdout.matchAll(REPORT_WRITTEN_LINE)].flatMap((m) => {
    const path = resolve(projectRoot, m[1]!);
    const rel = relative(projectRoot, path);
    return rel.startsWith('..') || isAbsolute(rel) ? [] : [path];
  });
}

/**
 * Report files a gate's JSON reporter may write instead of stdout (T13782):
 * every `--outputFile[.json]` the gate names, and {@link REDIRECTED_JSON_REPORT}.
 *
 * @param args - The gate's resolved arguments.
 * @param cwd - The gate's working directory.
 * @returns Absolute candidate paths.
 */
function reportFileCandidates(args: readonly string[], cwd: string): string[] {
  const named = args.flatMap((arg, i) => {
    const inline = arg.match(/^--outputFile(?:\.json)?=(.+)$/);
    if (inline) return [inline[1]!];
    return (arg === '--outputFile' || arg === '--outputFile.json') && args[i + 1]
      ? [args[i + 1]!]
      : [];
  });
  return [...new Set([...named, REDIRECTED_JSON_REPORT].map((p) => resolve(cwd, p)))];
}

/** A file's content hash and mtime, or null when it cannot be read. */
async function fileStamp(path: string): Promise<{ mtimeMs: number; sha256: string } | null> {
  try {
    const [info, bytes] = await Promise.all([stat(path), readFile(path)]);
    return { mtimeMs: info.mtimeMs, sha256: createHash('sha256').update(bytes).digest('hex') };
  } catch {
    return null;
  }
}

/**
 * Counts from a report file THIS run wrote (T13782), or null. A candidate
 * counts only when its bytes changed since just before the spawn (or it did
 * not exist), its mtime is not older than the spawn, and the report's own
 * `startTime`, when present, is not older than the spawn: a report left by an
 * earlier run is never read as this run's result.
 * shortcut: another process writing the same path during this run could be
 * read; a checkout runs one gate at a time, so a shared path is not expected.
 *
 * @param before - Each candidate's stamp just before the spawn.
 * @param startedAt - Epoch ms just before the spawn.
 * @returns Validated counts, or null.
 * @task T13782
 */
async function freshReportCounts(
  before: ReadonlyMap<string, { mtimeMs: number; sha256: string } | null>,
  startedAt: number,
): Promise<StructuredTestCounts | null> {
  for (const [path, was] of before) {
    const now = await fileStamp(path);
    if (now === null || now.mtimeMs < startedAt || (was !== null && was.sha256 === now.sha256))
      continue;
    try {
      const raw: { startTime?: unknown } = JSON.parse(await readFile(path, 'utf-8'));
      if (typeof raw.startTime === 'number' && raw.startTime < startedAt) continue;
      const report = testCountReportSchema.safeParse(raw);
      if (report.success) return report.data;
    } catch {
      // Unreadable or not JSON: not a report of this run.
    }
  }
  return null;
}

/**
 * The `minCount` remediation, naming the exact reporter flag for this runner.
 *
 * The message this replaced said only that a structured count was required. A
 * reader had no way to learn what "supported" meant, what shape was expected,
 * or which flag produced it — so the reported resolution was to delete the
 * `minCount` from the gate, which removes the guarantee rather than meeting it.
 *
 * @param gate - Gate whose command needs a machine-readable reporter.
 * @task T12308
 */
function describeMissingTestCount(gate: TestGate): string {
  const invoked = [gate.command, ...(gate.args ?? [])].join(' ');
  const flag = /jest/.test(invoked)
    ? '--json'
    : /vitest|pnpm|npm|yarn|bun/.test(invoked)
      ? '--reporter=json'
      : '<your runner\u2019s JSON reporter flag>';
  return (
    `minCount ${gate.minCount} cannot be proved: \`${invoked}\` emitted no machine-readable ` +
    `test report, and an exit code alone carries no count. Add a JSON reporter to the gate ` +
    `command itself (e.g. \`${invoked} ${flag}\`) so the run that is being attested is the ` +
    `run that is counted. A report file this run writes (its --outputFile, or ` +
    `${REDIRECTED_JSON_REPORT}) is read too, but one produced by a separate invocation is ` +
    `deliberately not accepted \u2014 it is not bound to this execution; record that as \`test-run:<path>\` ` +
    `evidence instead, or drop minCount if an exit code is the guarantee you want.`
  );
}

/**
 * Zero-count runner summaries that name failure without reporting any: node:test
 * (`ℹ fail 0`), TAP (`# fail 0`), `0 failed`, `0 failing`, `failures: 0`. They
 * are removed before the failure pattern looks at the output (T13511).
 */
const ZERO_FAILURE_COUNT =
  /\b0\s+(?:fail(?:ed|ing|ures?)?)\b|\bfail(?:ed|ing|ures?)?\s*[:=]?\s*0(?![\d.])/gi;

/**
 * A runner's line for one PASSING test (vitest/jest `✓`, mocha `✔`/`√`, TAP
 * `ok 3 - name`, jest `PASS file`): its text is a test name, never a verdict
 * (T13752). TAP `not ok` does not match.
 */
const PASSING_TEST_LINE = /^\s*(?:[✓✔√]|ok\s+\d|PASS\s).*$/gmu;

/**
 * Whether a test command's output reports a failure, for `expect: 'pass'`:
 * a `FAIL`, `failing` or `Error:` token, after removing summaries that report
 * zero failures (T13511 — `node --test` prints `ℹ fail 0` on success, which
 * the bare pattern read as a failure) and passing-test lines, whose test names
 * routinely say "failure" (T13752). A non-zero count still matches.
 * Only consulted when the run emitted no structured report.
 *
 * @param stdout - The command's captured stdout.
 * @returns True when the output reports a failure.
 * @example
 * ```ts
 * outputReportsFailure('ℹ pass 3\nℹ fail 0'); // false
 * outputReportsFailure('ℹ pass 2\nℹ fail 1'); // true
 * ```
 * @task T13511
 * @task T13752
 */
export function outputReportsFailure(stdout: string): boolean {
  // T13516: a non-zero count (`3 failed`, `1 failure`) is a failure too; the
  // FAIL token alone needs a word boundary, so `failed` never matched it.
  return /\bFAIL\b|failing|Error:|\b[1-9]\d*\s+fail(?:ed|ures?)\b/i.test(
    stdout.replace(PASSING_TEST_LINE, '').replace(ZERO_FAILURE_COUNT, ''),
  );
}

async function runTestGate(
  gate: TestGate,
  index: number,
  projectRoot: string,
  timeoutMs: number,
  context: ProcessCaptureOptions,
): Promise<AcceptanceGateResult> {
  const invocation = executableInvocation(gate, projectRoot, context.env ?? process.env)!;
  // T13782: a JSON reporter redirected to a file still yields this run's counts.
  const reportFiles = reportFileCandidates(invocation.args, invocation.cwd);
  const before = new Map(
    await Promise.all(reportFiles.map(async (p) => [p, await fileStamp(p)] as const)),
  );
  const startedAt = Date.now();
  const captured = await captureGateCommand(
    invocation.command,
    invocation.args,
    invocation.cwd,
    timeoutMs,
    'test-run',
    context,
    gate.env,
  );
  // T13752: a structured report decides the verdict; the text heuristic only
  // runs without one, since report JSON and test names are full of "failure".
  // T13874: a path the run announced has no pre-spawn stamp; mtime and the
  // report's startTime still have to postdate the spawn.
  for (const path of announcedReportFiles(captured.stdout, projectRoot))
    if (!before.has(path)) before.set(path, null);
  const counts = structuredTestCounts(captured) ?? (await freshReportCounts(before, startedAt));

  // T12308: the counts come from this run's own validated report; only their
  // ABSENCE is an error, because inferring a count from exit zero is the thing
  // that must not happen. T13753: the error keeps the run's execution record.
  if (gate.minCount !== undefined && gate.minCount > 0) {
    if (counts === null)
      return processGateResult(index, gate, captured, 'error', describeMissingTestCount(gate));
    if (counts.numPassedTests < gate.minCount)
      return processGateResult(
        index,
        gate,
        captured,
        'fail',
        `Structured report counts ${counts.numPassedTests} passing tests, below the required minimum of ${gate.minCount}`,
      );
  }
  if (captured.exitCode !== 0)
    return processGateResult(index, gate, captured, 'fail', `Exit code ${captured.exitCode}`);
  if (gate.expect === 'pass') {
    if (counts !== null && ((counts.numFailedTests ?? 0) > 0 || counts.success === false))
      return processGateResult(
        index,
        gate,
        captured,
        'fail',
        `Structured report counts ${counts.numFailedTests ?? 0} failing tests (success: ${counts.success ?? 'unreported'})`,
      );
    if (counts === null && outputReportsFailure(captured.stdout))
      return processGateResult(index, gate, captured, 'fail', 'Failure pattern detected in output');
  }
  return processGateResult(index, gate, captured, 'pass');
}

// ─── File gate ────────────────────────────────────────────────────────────────

async function runFileGate(
  gate: FileGate,
  index: number,
  projectRoot: string,
  context: ProcessCaptureOptions,
  storeRoot: string = projectRoot,
): Promise<AcceptanceGateResult> {
  const startMs = Date.now();

  let attachmentBytes: Buffer | undefined;
  let filePath: string;
  if (gate.attachmentSha256) {
    const store = createAttachmentStore();
    const metadata = await store.getMetadata(gate.attachmentSha256, storeRoot);
    assertGateActive(context);
    if (!metadata)
      return makeResult(
        index,
        gate,
        'fail',
        Date.now() - startMs,
        undefined,
        'Attachment not found',
      );
    const attachment = metadata.attachment;
    if (!('size' in attachment) || !Number.isSafeInteger(attachment.size) || attachment.size < 0)
      throw new Error('Attachment gate requires declared byte size for bounded retrieval');
    if (attachment.size > (context.maxOutputBytes ?? 1_048_576))
      throw new Error('Attachment gate exceeds declared byte limit');
    const result = await store.get(gate.attachmentSha256, storeRoot);
    assertGateActive(context);
    if (!result)
      throw new Error('Attachment metadata exists but authenticated bytes are unavailable');
    if (result.bytes.length > (context.maxOutputBytes ?? 1_048_576))
      throw new Error('Attachment bytes exceed declared limit');
    attachmentBytes = result.bytes;
    filePath = `sha256:${gate.attachmentSha256}`;
  } else if (gate.path) {
    filePath = isAbsolute(gate.path) ? gate.path : join(projectRoot, gate.path);
  } else throw new Error('FileGate requires path or attachmentSha256');

  const failures: string[] = [];
  let fileContent: Buffer | undefined = attachmentBytes;
  let fileSize = 0;
  let fileExists = false;

  // Check existence first
  try {
    const st = attachmentBytes ? { size: attachmentBytes.length } : await stat(filePath);
    fileExists = true;
    fileSize = st.size;
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    fileExists = false;
  }

  for (const assertion of gate.assertions) {
    assertGateActive(context);
    if (
      ['contains', 'matches', 'sha256'].includes(assertion.type) &&
      fileSize > (context.maxOutputBytes ?? 1_048_576)
    )
      throw new Error('File gate content exceeds declared byte limit');
    const failure = await checkFileAssertion(
      assertion,
      filePath,
      fileExists,
      fileSize,
      async () => {
        if (fileContent === undefined) {
          const limit = context.maxOutputBytes ?? 1_048_576;
          const handle = await open(filePath, 'r');
          try {
            const chunks: Buffer[] = [];
            let bytes = 0;
            for (;;) {
              assertGateActive(context);
              const chunk = Buffer.alloc(Math.min(65536, limit - bytes + 1));
              const read = await handle.read(chunk, 0, chunk.length, null);
              assertGateActive(context);
              if (read.bytesRead === 0) break;
              bytes += read.bytesRead;
              if (bytes > limit) throw new Error('File content exceeds declared byte limit');
              chunks.push(chunk.subarray(0, read.bytesRead));
            }
            fileContent = Buffer.concat(chunks);
          } finally {
            await handle.close();
          }
        }
        return fileContent;
      },
    );
    assertGateActive(context);
    if (failure) {
      failures.push(failure);
    }
  }

  const durationMs = Date.now() - startMs;

  if (failures.length > 0) {
    const evidence = `path=${filePath}\n${failures.join('\n')}`;
    return makeResult(
      index,
      gate,
      'fail',
      durationMs,
      truncateString(evidence, MAX_EVIDENCE_CHARS),
      failures[0],
    );
  }

  return makeResult(index, gate, 'pass', durationMs, `path=${filePath} — all assertions passed`);
}

/**
 * Run a single file assertion.
 *
 * @returns Error message string when the assertion fails, `null` when it passes.
 */
async function checkFileAssertion(
  assertion: FileAssertion,
  filePath: string,
  fileExists: boolean,
  fileSize: number,
  getContent: () => Promise<Buffer>,
): Promise<string | null> {
  switch (assertion.type) {
    case 'exists':
      return fileExists ? null : `File does not exist: ${filePath}`;

    case 'absent':
      return fileExists ? `File should be absent but exists: ${filePath}` : null;

    case 'nonEmpty':
      if (!fileExists) return `File does not exist: ${filePath}`;
      return fileSize > 0 ? null : `File is empty: ${filePath}`;

    case 'maxBytes':
      if (!fileExists) return `File does not exist: ${filePath}`;
      return fileSize <= assertion.value
        ? null
        : `File size ${fileSize} exceeds max ${assertion.value} bytes`;

    case 'minBytes':
      if (!fileExists) return `File does not exist: ${filePath}`;
      return fileSize >= assertion.value
        ? null
        : `File size ${fileSize} is below min ${assertion.value} bytes`;

    case 'contains': {
      if (!fileExists) return `File does not exist: ${filePath}`;
      const content = (await getContent()).toString('utf8');
      return content.includes(assertion.value)
        ? null
        : `File does not contain: ${JSON.stringify(assertion.value)}`;
    }

    case 'matches': {
      if (!fileExists) return `File does not exist: ${filePath}`;
      const content = (await getContent()).toString('utf8');
      const re = new RegExp(assertion.regex, assertion.flags);
      return re.test(content)
        ? null
        : `File does not match regex /${assertion.regex}/${assertion.flags ?? ''}`;
    }

    case 'sha256': {
      if (!fileExists) return `File does not exist: ${filePath}`;
      const raw = await getContent();
      const hash = createHash('sha256').update(raw).digest('hex');
      return hash === assertion.value
        ? null
        : `SHA-256 mismatch: expected ${assertion.value}, got ${hash}`;
    }

    default: {
      // Exhaustive check — TypeScript narrows FileAssertion to `never` here
      const _exhaustive: never = assertion;
      return `Unknown assertion type: ${JSON.stringify(_exhaustive)}`;
    }
  }
}

// ─── Command gate ─────────────────────────────────────────────────────────────

async function runCommandGate(
  gate: CommandGate,
  index: number,
  projectRoot: string,
  timeoutMs: number,
  context: ProcessCaptureOptions,
): Promise<AcceptanceGateResult> {
  const invocation = executableInvocation(gate, projectRoot, context.env ?? process.env)!;
  const captured = await captureGateCommand(
    invocation.command,
    invocation.args,
    invocation.cwd,
    timeoutMs,
    'scoped-build',
    context,
    gate.env,
  );
  const expected = gate.exitCode ?? 0;
  let reason =
    captured.exitCode === expected
      ? undefined
      : `Exit code ${captured.exitCode} (expected ${expected})`;
  if (!reason && gate.stdoutMatches && !new RegExp(gate.stdoutMatches).test(captured.stdout))
    reason = 'stdout pattern did not match';
  if (!reason && gate.stderrMatches && !new RegExp(gate.stderrMatches).test(captured.stderr))
    reason = 'stderr pattern did not match';
  return processGateResult(index, gate, captured, reason ? 'fail' : 'pass', reason);
}

/**
 * Tool-specific executable, default arguments and failure pattern of a typed
 * lint gate. A gate fails on a non-zero exit, and with `expect: 'clean'` also
 * when the output matches `errorPattern`. Shared with `cleo goal draft` (T13793).
 */
export const LINT_TOOL_DEFAULTS: Record<
  LintGate['tool'],
  { cmd: string; defaultArgs: string[]; errorPattern?: RegExp }
> = {
  biome: { cmd: 'biome', defaultArgs: ['check', '.'] },
  eslint: { cmd: 'eslint', defaultArgs: ['.'] },
  tsc: { cmd: 'tsc', defaultArgs: ['--noEmit'] },
  prettier: { cmd: 'prettier', defaultArgs: ['--check', '.'] },
  rustc: { cmd: 'rustc', defaultArgs: ['--edition', '2021', '--crate-type', 'lib'] },
  clippy: {
    cmd: 'cargo',
    defaultArgs: ['clippy', '--', '-D', 'warnings'],
    errorPattern: /^error/m,
  },
};

async function runLintGate(
  gate: LintGate,
  index: number,
  projectRoot: string,
  timeoutMs: number,
  context: ProcessCaptureOptions,
): Promise<AcceptanceGateResult> {
  const tool = LINT_TOOL_DEFAULTS[gate.tool];
  const invocation = executableInvocation(gate, projectRoot, context.env ?? process.env)!;
  const captured = await captureGateCommand(
    invocation.command,
    invocation.args,
    invocation.cwd,
    timeoutMs,
    'scoped-build',
    context,
  );
  const passed =
    captured.exitCode === 0 &&
    (gate.expect === 'noErrors' || !tool.errorPattern?.test(captured.stdout + captured.stderr));
  return processGateResult(
    index,
    gate,
    captured,
    passed ? 'pass' : 'fail',
    `${gate.tool} reported errors (exit ${captured.exitCode})`,
  );
}

// ─── HTTP gate ────────────────────────────────────────────────────────────────

async function runHttpGate(
  gate: HttpGate,
  index: number,
  _projectRoot: string,
  timeoutMs: number,
  context: ProcessCaptureOptions,
): Promise<AcceptanceGateResult> {
  const startMs = Date.now();
  if (gate.startCommand)
    throw new Error(
      'HTTP server startup requires an admitted owned service lifetime; unowned detached startup is unavailable',
    );
  let statusCode = 0;
  let body = '';
  let errorMsg: string | undefined;

  try {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      Math.max(0, Math.min(timeoutMs, context.execution.deadlineAt - Date.now())),
    );

    try {
      const response = await fetch(gate.url, {
        method: gate.method ?? 'GET',
        headers: gate.headers,
        signal: context.execution.signal
          ? AbortSignal.any([controller.signal, context.execution.signal])
          : controller.signal,
      });
      statusCode = response.status;
      if (response.body) {
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        try {
          for (;;) {
            assertGateActive(context);
            const next = await reader.read();
            if (next.done) break;
            bytes += next.value.byteLength;
            if (bytes > (context.maxOutputBytes ?? 1_048_576))
              throw new Error('HTTP body exceeds declared byte limit');
            chunks.push(next.value);
          }
          body = Buffer.concat(chunks).toString('utf8');
        } finally {
          await reader.cancel();
          reader.releaseLock();
        }
      }
      assertGateActive(context);
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    errorMsg = err instanceof Error ? err.message : String(err);
  }

  const durationMs = Date.now() - startMs;

  if (errorMsg) {
    return makeResult(
      index,
      gate,
      'error',
      durationMs,
      errorMsg,
      `HTTP gate did not finish: ${errorMsg}`,
    );
  }

  if (statusCode !== gate.status) {
    return makeResult(
      index,
      gate,
      'fail',
      durationMs,
      `HTTP ${statusCode}`,
      `Expected status ${gate.status}, got ${statusCode}`,
    );
  }

  if (gate.bodyMatches) {
    const re = new RegExp(gate.bodyMatches);
    if (!re.test(body)) {
      return makeResult(
        index,
        gate,
        'fail',
        durationMs,
        truncateString(body, 500),
        `Response body did not match /${gate.bodyMatches}/`,
      );
    }
  }

  const evidence = `HTTP ${statusCode} — ${gate.url}`;
  return makeResult(index, gate, 'pass', durationMs, evidence);
}

// ─── Manual gate ──────────────────────────────────────────────────────────────

function runManualGate(
  gate: ManualGate,
  index: number,
  _skipManual: boolean,
): AcceptanceGateResult {
  // Manual gates always return skipped; a human or different agent must
  // set the verdict explicitly via `cleo verify --manual`.
  return {
    index,
    req: gate.req,
    kind: 'manual',
    result: 'skipped',
    durationMs: 0,
    evidence: `Manual gate requires explicit acceptance. Prompt: ${gate.prompt}`,
    checkedAt: new Date().toISOString(),
    checkedBy: CHECKED_BY,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a resolved working-directory path.
 * Relative `cwd` values are resolved relative to `projectRoot`.
 */
function resolveCwd(projectRoot: string, cwd?: string): string {
  if (!cwd) return projectRoot;
  return isAbsolute(cwd) ? cwd : join(projectRoot, cwd);
}

/** Construct an `AcceptanceGateResult` record. */
function makeResult(
  index: number,
  gate: AcceptanceGate,
  result: AcceptanceGateResult['result'],
  durationMs: number,
  evidence?: string,
  errorMessage?: string,
): AcceptanceGateResult {
  // Apply advisory override: a failed advisory gate becomes 'warn'.
  //
  // Deliberately keyed on 'fail' alone. An 'error' result (gh#1270 — the gate
  // was killed and produced no verdict) must NOT be downgraded to 'warn': a
  // warning reads as "we looked and it was nearly fine", which is the opposite
  // of "we never finished looking". Advisory is a statement about how much a
  // verdict matters, and a killed gate has no verdict to soften.
  const finalResult = result === 'fail' && gate.advisory === true ? 'warn' : result;

  return {
    index,
    req: gate.req,
    kind: gate.kind,
    result: finalResult,
    durationMs,
    evidence: evidence ? evidence.trim() : undefined,
    errorMessage: finalResult !== 'pass' ? errorMessage : undefined,
    checkedAt: new Date().toISOString(),
    checkedBy: CHECKED_BY,
  };
}

/**
 * Filter a mixed acceptance array to only typed `AcceptanceGate` objects.
 * Free-text strings are silently dropped with their original index preserved
 * via the `index` field of each result.
 *
 * @param items  - Mixed `(string | AcceptanceGate)[]` from `task.acceptance`.
 * @returns      Typed gates with their original indices.
 */
export function extractTypedGates(
  items: (string | AcceptanceGate)[],
): Array<{ gate: AcceptanceGate; originalIndex: number }> {
  return items
    .map((item, i) => ({ item, i }))
    .filter(
      (x): x is { item: AcceptanceGate; i: number } =>
        typeof x.item === 'object' && x.item !== null && 'kind' in x.item,
    )
    .map(({ item, i }) => ({ gate: item, originalIndex: i }));
}
