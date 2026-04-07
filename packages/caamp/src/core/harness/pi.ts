/**
 * Pi coding agent harness.
 *
 * @remarks
 * Concrete {@link Harness} implementation for the Pi coding agent
 * (https://github.com/badlogic/pi-mono). Pi is CAAMP's first first-class
 * primary harness: it owns skills, instructions, extensions, and subagent
 * spawning through native filesystem conventions rather than a generic
 * MCP config file.
 *
 * Filesystem layout honoured by this harness:
 * - Global state root: `$PI_CODING_AGENT_DIR` if set, else `~/.pi/agent/`.
 * - Global skills: `<root>/skills/<name>/`
 * - Global extensions: `<root>/extensions/*.ts`
 * - Global settings: `<root>/settings.json`
 * - Global instructions: `<root>/AGENTS.md`
 * - Project skills: `<projectDir>/.pi/skills/<name>/`
 * - Project extensions: `<projectDir>/.pi/extensions/*.ts`
 * - Project settings: `<projectDir>/.pi/settings.json`
 * - Project instructions: `<projectDir>/AGENTS.md` (at project root, NOT under `.pi/`)
 *
 * @packageDocumentation
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { type Dirent, existsSync } from 'node:fs';
import {
  appendFile,
  cp,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { parseDocument, validateDocument } from '@cleocode/cant';
import type { Provider } from '../../types.js';
import type { HarnessTier } from './scope.js';
import { resolveAllTiers, resolveTierDir } from './scope.js';
import type {
  CantProfileCounts,
  CantProfileEntry,
  CantValidationDiagnostic,
  ExtensionEntry,
  Harness,
  HarnessInstallOptions,
  HarnessScope,
  ModelListEntry,
  PiModelProvider,
  PiModelsConfig,
  PromptEntry,
  SessionDocument,
  SessionSummary,
  SubagentExitResult,
  SubagentHandle,
  SubagentLinkEntry,
  SubagentResult,
  SubagentSpawnOptions,
  SubagentStreamEvent,
  SubagentTask,
  ThemeEntry,
  ValidateCantProfileResult,
} from './types.js';

// ── Marker constants ──────────────────────────────────────────────────

/** Start marker for CAAMP-managed AGENTS.md injection blocks. */
const MARKER_START = '<!-- CAAMP:START -->';
/** End marker for CAAMP-managed AGENTS.md injection blocks. */
const MARKER_END = '<!-- CAAMP:END -->';
/** Matches an entire CAAMP-managed block including its markers. */
const MARKER_PATTERN = /<!-- CAAMP:START -->[\s\S]*?<!-- CAAMP:END -->/;

// ── Private helpers ───────────────────────────────────────────────────

/**
 * Resolve the Pi global state root directory.
 *
 * @remarks
 * Honours the `PI_CODING_AGENT_DIR` environment variable when set (with
 * `~` expansion), else falls back to `~/.pi/agent`. Kept private to this
 * module so tests can redirect it via the env var.
 */
function getPiAgentDir(): string {
  const env = process.env['PI_CODING_AGENT_DIR'];
  if (env !== undefined && env.length > 0) {
    if (env === '~') return homedir();
    if (env.startsWith('~/')) return join(homedir(), env.slice(2));
    return env;
  }
  return join(homedir(), '.pi', 'agent');
}

/**
 * Narrow a value to a plain object suitable for deep merge.
 */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Recursively merge `patch` into `target`, returning a new object.
 *
 * @remarks
 * Nested plain objects are merged field-by-field. All other value types
 * (arrays, primitives, `null`) are replaced wholesale by the patch value.
 */
function deepMerge(
  target: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...target };
  for (const [key, value] of Object.entries(patch)) {
    const existing = out[key];
    if (isPlainObject(value) && isPlainObject(existing)) {
      out[key] = deepMerge(existing, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Write JSON to disk atomically via a tmp-then-rename sequence.
 *
 * @remarks
 * Ensures partial writes cannot leave a corrupted `settings.json` behind
 * if the process dies mid-write. The tmp filename is namespaced by pid
 * to stay unique under parallel runs.
 */
async function atomicWriteJson(filePath: string, data: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  await rename(tmp, filePath);
}

// ── Subagent runtime constants & orphan tracker (ADR-035 §D6) ─────────

/**
 * Default SIGTERM grace window before SIGKILL fires.
 *
 * @remarks
 * Per ADR-035 §D6 the configurable default is 5 seconds. Callers can
 * override per-spawn via {@link SubagentSpawnOptions.terminateGraceMs}
 * or globally via `settings.json:pi.subagent.terminateGraceMs`.
 */
const DEFAULT_TERMINATE_GRACE_MS = 5000;

/** Maximum number of stderr lines retained per subagent for diagnostics. */
const STDERR_RING_BUFFER_SIZE = 100;

/**
 * Internal record describing a live subagent so the module-level orphan
 * sweeper can terminate stragglers on parent exit.
 */
interface ActiveSubagent {
  child: ChildProcess;
  subagentId: string;
  terminate: () => void;
}

/**
 * Set of currently-live subagents owned by this PiHarness module.
 *
 * @remarks
 * Used by {@link ensureOrphanSweeperRegistered} so that on parent
 * shutdown every still-running subagent receives the cleanup signal
 * sequence. Entries are removed as soon as a child exits naturally.
 */
const activeSubagents = new Set<ActiveSubagent>();

/** Tracks whether the process-exit orphan sweeper has been registered. */
let orphanSweeperRegistered = false;

/**
 * Register a one-shot `process.on('exit', ...)` handler that terminates
 * any still-active subagents when the parent process is shutting down.
 *
 * @remarks
 * Idempotent — subsequent calls are no-ops. The handler walks
 * {@link activeSubagents} and invokes each entry's terminate hook so
 * the SIGTERM-then-SIGKILL sequence runs uniformly across crash and
 * graceful shutdown paths. Synchronous because Node's `'exit'` event
 * does not await async work.
 */
function ensureOrphanSweeperRegistered(): void {
  if (orphanSweeperRegistered) return;
  orphanSweeperRegistered = true;
  const sweeper = (): void => {
    for (const entry of activeSubagents) {
      try {
        entry.terminate();
      } catch {
        // Best-effort: a child that's already gone is fine.
      }
    }
  };
  process.on('exit', sweeper);
}

/**
 * Generate a short unique suffix for subagent ids and ad-hoc task ids.
 *
 * @remarks
 * Combines a timestamp with `Math.random` for collision resistance
 * inside a single process. Not cryptographically strong — these ids are
 * filesystem identifiers, not credentials.
 */
function generateShortId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${ts}${rand}`;
}

/**
 * Read `settings.json:pi.subagent.terminateGraceMs` from a settings blob.
 *
 * @remarks
 * Tolerant of missing or non-numeric values — falls through to the
 * supplied default when the path does not resolve to a positive finite
 * number. Centralised here so both spawn-time defaulting and tests can
 * share the lookup logic.
 */
function readTerminateGraceFromSettings(settings: unknown, fallback: number): number {
  if (!isPlainObject(settings)) return fallback;
  const piBlock = settings['pi'];
  if (!isPlainObject(piBlock)) return fallback;
  const subBlock = piBlock['subagent'];
  if (!isPlainObject(subBlock)) return fallback;
  const value = subBlock['terminateGraceMs'];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return fallback;
  return value;
}

// ── PiHarness ─────────────────────────────────────────────────────────

/**
 * Pi coding agent harness — CAAMP's first-class primary harness.
 *
 * @remarks
 * Implements the full {@link Harness} contract using Pi's filesystem
 * conventions. All mutating operations are idempotent: re-installing a
 * skill overwrites it cleanly, injecting instructions twice replaces the
 * marker block rather than appending, and removing absent assets is a
 * no-op.
 *
 * @see {@link https://github.com/badlogic/pi-mono | pi-mono}
 *
 * @public
 */
export class PiHarness implements Harness {
  /** Provider id, always `"pi"`. */
  readonly id = 'pi';

  /**
   * Construct a harness bound to a resolved Pi provider.
   *
   * @param provider - The resolved provider entry for `"pi"`.
   */
  constructor(readonly provider: Provider) {}

  // ── Path helpers ────────────────────────────────────────────────────

  /**
   * Resolve the skills directory for a given scope.
   */
  private skillsDir(scope: HarnessScope): string {
    return scope.kind === 'global'
      ? join(getPiAgentDir(), 'skills')
      : join(scope.projectDir, '.pi', 'skills');
  }

  /**
   * Resolve the settings.json path for a given scope.
   */
  private settingsPath(scope: HarnessScope): string {
    return scope.kind === 'global'
      ? join(getPiAgentDir(), 'settings.json')
      : join(scope.projectDir, '.pi', 'settings.json');
  }

  /**
   * Resolve the AGENTS.md instruction file path for a given scope.
   *
   * @remarks
   * Global scope lives under the Pi state root; project scope lives at
   * the project root (NOT under `.pi/`), matching Pi's convention of
   * auto-discovering `AGENTS.md` from the working directory upwards.
   */
  private agentsMdPath(scope: HarnessScope): string {
    return scope.kind === 'global'
      ? join(getPiAgentDir(), 'AGENTS.md')
      : join(scope.projectDir, 'AGENTS.md');
  }

  // ── Skills ──────────────────────────────────────────────────────────

  /** {@inheritDoc Harness.installSkill} */
  async installSkill(sourcePath: string, skillName: string, scope: HarnessScope): Promise<void> {
    const targetDir = join(this.skillsDir(scope), skillName);
    await rm(targetDir, { recursive: true, force: true });
    await mkdir(dirname(targetDir), { recursive: true });
    await cp(sourcePath, targetDir, { recursive: true });
  }

  /** {@inheritDoc Harness.removeSkill} */
  async removeSkill(skillName: string, scope: HarnessScope): Promise<void> {
    const targetDir = join(this.skillsDir(scope), skillName);
    await rm(targetDir, { recursive: true, force: true });
  }

  /** {@inheritDoc Harness.listSkills} */
  async listSkills(scope: HarnessScope): Promise<string[]> {
    const dir = this.skillsDir(scope);
    if (!existsSync(dir)) return [];
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  }

  // ── Instructions ────────────────────────────────────────────────────

  /** {@inheritDoc Harness.injectInstructions} */
  async injectInstructions(content: string, scope: HarnessScope): Promise<void> {
    const filePath = this.agentsMdPath(scope);
    await mkdir(dirname(filePath), { recursive: true });

    const block = `${MARKER_START}\n${content.trim()}\n${MARKER_END}`;

    let existing = '';
    if (existsSync(filePath)) {
      existing = await readFile(filePath, 'utf8');
    }

    let updated: string;
    if (MARKER_PATTERN.test(existing)) {
      updated = existing.replace(MARKER_PATTERN, block);
    } else if (existing.length === 0) {
      updated = `${block}\n`;
    } else {
      const separator = existing.endsWith('\n') ? '\n' : '\n\n';
      updated = `${existing}${separator}${block}\n`;
    }
    await writeFile(filePath, updated, 'utf8');
  }

  /** {@inheritDoc Harness.removeInstructions} */
  async removeInstructions(scope: HarnessScope): Promise<void> {
    const filePath = this.agentsMdPath(scope);
    if (!existsSync(filePath)) return;
    const existing = await readFile(filePath, 'utf8');
    if (!MARKER_PATTERN.test(existing)) return;
    const stripped = existing
      .replace(MARKER_PATTERN, '')
      .replace(/\n{3,}/g, '\n\n')
      .trimEnd();
    await writeFile(filePath, stripped.length === 0 ? '' : `${stripped}\n`, 'utf8');
  }

  // ── Subagent spawn (ADR-035 §D6) ────────────────────────────────────

  /**
   * Spawn a subagent through Pi's configured `spawnCommand` and return a
   * live handle bound to the canonical streaming, attribution, and
   * cleanup contract.
   *
   * @remarks
   * Per ADR-035 §D6 this is the **only** sanctioned subagent spawn path
   * in CLEO. All historical direct `child_process.spawn` callers in
   * subagent contexts (including the `cant-bridge.ts` Pi extension and
   * the legacy CLEO orchestrator paths) MUST migrate to this method so
   * the contract below holds uniformly. A custom biome rule banning
   * raw `spawn()` from subagent code is planned for v3 cleanup but is
   * intentionally NOT enforced in v2 to keep the migration incremental.
   *
   * **Streaming semantics** — Pi's `--mode json` produces line-delimited
   * JSON on stdout. The harness:
   *
   * - Line-buffers stdout, parses each line as JSON, and forwards a
   *   `{ kind: 'message', subagentId, lineNumber, payload }`
   *   {@link SubagentStreamEvent} via {@link SubagentSpawnOptions.onStream}.
   *   Non-parseable lines increment a warning counter (recorded in the
   *   child session as `{ type: 'raw' }`) but never crash the loop.
   * - Line-buffers stderr separately, forwards each line as
   *   `{ kind: 'stderr', subagentId, payload: { line } }`, and stores
   *   it in a 100-line ring buffer accessible via
   *   {@link SubagentHandle.recentStderr}. Stderr is **never** injected
   *   into the parent LLM context per ADR-035 §D6.
   * - Emits a final `{ kind: 'exit', subagentId, payload: SubagentExitResult }`
   *   when the child terminates.
   *
   * **Session attribution** — Every spawn produces a child session JSONL
   * file at
   * `~/.pi/agent/sessions/subagents/subagent-{parentSessionId}-{taskId}.jsonl`.
   * The header line records the subagentId, taskId, and parent linkage.
   * When {@link SubagentTask.parentSessionPath} is supplied, a
   * {@link SubagentLinkEntry} is appended to the parent session file as
   * a JSONL line so listing the parent surfaces its children.
   *
   * **Exit propagation** — {@link SubagentHandle.exitPromise} resolves
   * with `{ code, signal, childSessionPath, durationMs }` exactly once
   * when the child exits. The promise NEVER rejects: failure is
   * encoded by a non-zero `code`, a non-null `signal`, or partial
   * output preserved in the child session file.
   *
   * **Cleanup** — {@link SubagentHandle.terminate} sends SIGTERM, waits
   * the configured grace window, then sends SIGKILL if the child is
   * still alive. The grace window is sourced from
   * {@link SubagentSpawnOptions.terminateGraceMs} when supplied,
   * otherwise from `settings.json:pi.subagent.terminateGraceMs`,
   * otherwise from {@link DEFAULT_TERMINATE_GRACE_MS}. A
   * `subagent_exit` entry with reason `terminated` is appended to the
   * child session file when cleanup runs.
   *
   * **Concurrency** — Use the static helpers
   * {@link PiHarness.raceSubagents} and
   * {@link PiHarness.settleAllSubagents} to compose `parallel: race`
   * and `parallel: settle` constructs from CANT workflows over multiple
   * handles.
   *
   * **Orphan handling** — On the first spawn the harness registers a
   * process-wide `'exit'` handler that terminates every still-active
   * subagent so a parent crash never strands children.
   *
   * Throws immediately when the provider entry is missing a
   * `spawnCommand` so callers see configuration errors early rather
   * than at child-exit time.
   *
   * @param task - Subagent task specification.
   * @param opts - Per-call streaming and cleanup overrides.
   * @returns A live subagent handle.
   */
  async spawnSubagent(
    task: SubagentTask,
    opts: SubagentSpawnOptions = {},
  ): Promise<SubagentHandle> {
    const cmd = this.provider.capabilities.spawn.spawnCommand;
    if (cmd === null || cmd.length === 0) {
      throw new Error(
        'PiHarness.spawnSubagent: provider has no spawn.spawnCommand in capabilities',
      );
    }

    const program = cmd[0];
    if (typeof program !== 'string' || program.length === 0) {
      throw new Error('PiHarness.spawnSubagent: invalid spawnCommand (missing program)');
    }

    // Resolve identity + paths up front so they are stable across the
    // streaming + cleanup callbacks below.
    const taskId = task.taskId ?? generateShortId();
    const parentSessionId = task.parentSessionId ?? 'orphan';
    const subagentId = `sub-${taskId}-${generateShortId().slice(0, 6)}`;
    const childSessionPath = join(
      getPiAgentDir(),
      'sessions',
      'subagents',
      `subagent-${parentSessionId}-${taskId}.jsonl`,
    );
    await mkdir(dirname(childSessionPath), { recursive: true });

    // Resolve the SIGTERM grace window: per-call override → settings.json
    // → hardcoded default. Read settings via the public reader so the
    // standard tolerant-merge contract applies.
    let grace = opts.terminateGraceMs;
    if (grace === undefined) {
      try {
        const settings = await this.readSettings({ kind: 'global' });
        grace = readTerminateGraceFromSettings(settings, DEFAULT_TERMINATE_GRACE_MS);
      } catch {
        grace = DEFAULT_TERMINATE_GRACE_MS;
      }
    }
    if (!Number.isFinite(grace) || grace < 0) {
      grace = DEFAULT_TERMINATE_GRACE_MS;
    }

    const startedAt = new Date();
    const startedAtIso = startedAt.toISOString();

    // Write the child session header so `listSessions` and `showSession`
    // can attribute the file even before the child has produced output.
    const sessionHeader = {
      type: 'session',
      version: 3,
      id: subagentId,
      timestamp: startedAtIso,
      cwd: opts.cwd ?? task.cwd ?? process.cwd(),
      parentSession: task.parentSessionId ?? null,
      taskId,
      childSessionPath,
    };
    await writeFile(childSessionPath, `${JSON.stringify(sessionHeader)}\n`, 'utf8');

    // Spawn the child. Per-call overrides win over task-level fields.
    const baseArgs = cmd.slice(1);
    const args = [...baseArgs, task.prompt];
    const child = spawn(program, args, {
      cwd: opts.cwd ?? task.cwd,
      env: { ...process.env, ...task.env, ...opts.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Streaming state — line buffers, captured aggregates, and the
    // bounded stderr ring buffer.
    let stdoutAccum = '';
    let stderrAccum = '';
    let stdoutBuffer = '';
    let stderrBuffer = '';
    let stdoutLineNumber = 0;
    let nonJsonLineCount = 0;
    const stderrRing: string[] = [];

    const safeOnStream = (event: SubagentStreamEvent): void => {
      if (opts.onStream === undefined) return;
      try {
        opts.onStream(event);
      } catch (err) {
        // Never let user-callback errors abort the spawn loop. Record
        // the failure as a stderr line so it surfaces in diagnostics.
        const message = err instanceof Error ? err.message : String(err);
        stderrRing.push(`[onStream] ${message}`);
        if (stderrRing.length > STDERR_RING_BUFFER_SIZE) stderrRing.shift();
      }
    };

    const writeChildSession = (entry: Record<string, unknown>): void => {
      // Best-effort fire-and-forget append. We do NOT await here because
      // the streaming loop must keep up with stdout chunks; ordering
      // within the file is preserved by Node's append semantics for a
      // single-writer file.
      void appendFile(childSessionPath, `${JSON.stringify(entry)}\n`, 'utf8').catch(() => {
        // Disk errors are recorded as a synthetic stderr line so they
        // surface in `recentStderr` without aborting the child.
        const synthetic = `[childSession] failed to append entry`;
        stderrRing.push(synthetic);
        if (stderrRing.length > STDERR_RING_BUFFER_SIZE) stderrRing.shift();
      });
    };

    const flushStdoutBuffer = (final: boolean): void => {
      let nlIdx = stdoutBuffer.indexOf('\n');
      while (nlIdx !== -1) {
        const line = stdoutBuffer.slice(0, nlIdx);
        stdoutBuffer = stdoutBuffer.slice(nlIdx + 1);
        this.handleStdoutLine(line, {
          subagentId,
          increment: () => ++stdoutLineNumber,
          incrementNonJson: () => ++nonJsonLineCount,
          writeChildSession,
          safeOnStream,
        });
        nlIdx = stdoutBuffer.indexOf('\n');
      }
      // On final flush, drain any trailing partial line so the JSON
      // parser still gets a chance at it.
      if (final && stdoutBuffer.length > 0) {
        const remainder = stdoutBuffer;
        stdoutBuffer = '';
        this.handleStdoutLine(remainder, {
          subagentId,
          increment: () => ++stdoutLineNumber,
          incrementNonJson: () => ++nonJsonLineCount,
          writeChildSession,
          safeOnStream,
        });
      }
    };

    const flushStderrBuffer = (final: boolean): void => {
      let nlIdx = stderrBuffer.indexOf('\n');
      while (nlIdx !== -1) {
        const line = stderrBuffer.slice(0, nlIdx);
        stderrBuffer = stderrBuffer.slice(nlIdx + 1);
        stderrRing.push(line);
        if (stderrRing.length > STDERR_RING_BUFFER_SIZE) stderrRing.shift();
        writeChildSession({ type: 'subagent_stderr', line });
        safeOnStream({ kind: 'stderr', subagentId, payload: { line } });
        nlIdx = stderrBuffer.indexOf('\n');
      }
      if (final && stderrBuffer.length > 0) {
        const line = stderrBuffer;
        stderrBuffer = '';
        stderrRing.push(line);
        if (stderrRing.length > STDERR_RING_BUFFER_SIZE) stderrRing.shift();
        writeChildSession({ type: 'subagent_stderr', line });
        safeOnStream({ kind: 'stderr', subagentId, payload: { line } });
      }
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stdoutAccum += text;
      stdoutBuffer += text;
      flushStdoutBuffer(false);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stderrAccum += text;
      stderrBuffer += text;
      flushStderrBuffer(false);
    });

    // Cleanup state — single shared object so the terminate path,
    // exitPromise resolver, and orphan sweeper all observe the same
    // values without re-entrancy bugs.
    let terminating = false;
    let terminationReason: 'natural' | 'terminated' = 'natural';
    let terminatePromise: Promise<void> | null = null;

    const terminateImpl = (): Promise<void> => {
      if (terminatePromise !== null) return terminatePromise;
      terminating = true;
      terminationReason = 'terminated';
      terminatePromise = terminateSubagent(child, grace ?? DEFAULT_TERMINATE_GRACE_MS);
      return terminatePromise;
    };

    // Synchronous variant used by the orphan sweeper (process 'exit' is
    // synchronous and cannot await async work).
    const terminateSync = (): void => {
      if (terminating) return;
      terminating = true;
      terminationReason = 'terminated';
      try {
        child.kill('SIGTERM');
      } catch {
        // Already gone — fine.
      }
    };

    // Track this subagent so the orphan sweeper can clean it up if the
    // parent crashes before exit fires.
    const activeRecord: ActiveSubagent = {
      child,
      subagentId,
      terminate: terminateSync,
    };
    activeSubagents.add(activeRecord);
    ensureOrphanSweeperRegistered();

    // Wire up the legacy abort-signal channel so existing callers that
    // pass `task.signal` keep working under the new cleanup contract.
    if (task.signal !== undefined) {
      const onAbort = (): void => {
        void terminateImpl();
      };
      if (task.signal.aborted) {
        onAbort();
      } else {
        task.signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    // Build the rich exit promise. Resolves on `'close'` (which fires
    // after stdio streams have flushed) so we observe the final stdout
    // chunk before resolving. NEVER rejects.
    const exitPromise: Promise<SubagentExitResult> = new Promise((resolve) => {
      child.on('close', (exitCode, signal) => {
        // Flush any trailing partial lines from both streams so the
        // child session file captures the full conversation.
        flushStdoutBuffer(true);
        flushStderrBuffer(true);

        const durationMs = Date.now() - startedAt.getTime();
        writeChildSession({
          type: 'subagent_exit',
          code: exitCode,
          signal,
          reason: terminationReason,
          durationMs,
          nonJsonLineCount,
        });

        activeSubagents.delete(activeRecord);

        const result: SubagentExitResult = {
          code: exitCode,
          signal,
          childSessionPath,
          durationMs,
        };
        safeOnStream({ kind: 'exit', subagentId, payload: result });
        resolve(result);
      });
      // A spawn failure (e.g. ENOENT) emits 'error' before 'close'.
      // Synthesise a deterministic exit so the promise still resolves
      // and the file system state is consistent.
      child.on('error', () => {
        // 'close' will fire after 'error'; nothing else to do here.
      });
    });

    // Build the legacy v1 result promise from the same data so existing
    // callers (and the existing test suite) keep working unchanged.
    const result: Promise<SubagentResult> = exitPromise.then(({ code }) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(stdoutAccum);
      } catch {
        // Non-JSON aggregate is fine — leave parsed undefined.
      }
      return { exitCode: code, stdout: stdoutAccum, stderr: stderrAccum, parsed };
    });

    // Append the parent-side `subagent_link` entry. We do this AFTER the
    // child has been spawned successfully so a spawn failure is not
    // recorded as a live link in the parent file.
    const linkEntry: SubagentLinkEntry = {
      type: 'subagent_link',
      subagentId,
      taskId,
      childSessionPath,
      startedAt: startedAtIso,
    };
    if (task.parentSessionPath !== undefined && task.parentSessionPath.length > 0) {
      try {
        await writeSubagentLink(task.parentSessionPath, linkEntry);
        safeOnStream({ kind: 'link', subagentId, payload: linkEntry });
      } catch {
        // Parent file unwritable — record diagnostically and continue.
        // We do NOT fail the spawn because the child is already running.
        stderrRing.push(`[link] failed to write subagent_link to parent`);
        if (stderrRing.length > STDERR_RING_BUFFER_SIZE) stderrRing.shift();
      }
    }

    return {
      subagentId,
      taskId,
      childSessionPath,
      pid: child.pid ?? null,
      startedAt,
      exitPromise,
      result,
      terminate: terminateImpl,
      abort: () => {
        void terminateImpl();
      },
      recentStderr: () => stderrRing.slice(),
    };
  }

  /**
   * Race a set of subagent handles, returning the first one that exits.
   *
   * @remarks
   * Maps CANT's `parallel: race` construct (per ADR-035 §D6) onto the
   * canonical {@link spawnSubagent} contract. The losing handles are
   * gracefully terminated via {@link SubagentHandle.terminate} once the
   * first settles so no straggler children outlive the race.
   *
   * @param handles - Subagent handles to race.
   * @returns The {@link SubagentExitResult} of the first child to exit.
   * @throws When `handles` is empty (caller bug — a race over zero
   *   children has no winner).
   */
  static async raceSubagents(handles: SubagentHandle[]): Promise<SubagentExitResult> {
    if (handles.length === 0) {
      throw new Error('PiHarness.raceSubagents: cannot race an empty handle list');
    }
    // Tag each promise with its index so we can identify the loser set.
    const tagged = handles.map((handle, index) =>
      handle.exitPromise.then((value) => ({ index, value })),
    );
    const winner = await Promise.race(tagged);
    // Terminate the losers in parallel; ignore individual errors so a
    // single stuck child cannot block the race resolution.
    const losers: Promise<void>[] = [];
    for (let i = 0; i < handles.length; i += 1) {
      if (i === winner.index) continue;
      const loser = handles[i];
      if (loser === undefined) continue;
      losers.push(loser.terminate().catch(() => undefined));
    }
    await Promise.all(losers);
    return winner.value;
  }

  /**
   * Settle a set of subagent handles, returning a parallel array of
   * results.
   *
   * @remarks
   * Maps CANT's `parallel: settle` construct (per ADR-035 §D6) onto the
   * canonical {@link spawnSubagent} contract. Because
   * {@link SubagentHandle.exitPromise} never rejects, every entry in
   * the returned array is `{ status: 'fulfilled', value: ... }` under
   * normal operation; the `PromiseSettledResult` shape is preserved
   * for forward compatibility with future failure modes.
   *
   * @param handles - Subagent handles to settle.
   * @returns Parallel array of settled exit results, one per input.
   */
  static async settleAllSubagents(
    handles: SubagentHandle[],
  ): Promise<PromiseSettledResult<SubagentExitResult>[]> {
    return Promise.allSettled(handles.map((h) => h.exitPromise));
  }

  /**
   * Per-line stdout dispatcher used by the streaming buffer flusher.
   *
   * @remarks
   * Extracted as a private method so the line-handling logic stays
   * close to {@link spawnSubagent} but does not bloat the parent
   * function. Skips empty lines (a leading newline produces a zero-
   * length entry that has no semantic meaning).
   */
  private handleStdoutLine(
    rawLine: string,
    ctx: {
      subagentId: string;
      increment: () => number;
      incrementNonJson: () => number;
      writeChildSession: (entry: Record<string, unknown>) => void;
      safeOnStream: (event: SubagentStreamEvent) => void;
    },
  ): void {
    // Pi prints `\r\n` on Windows and `\n` on POSIX; strip a trailing
    // CR so JSON.parse never sees it.
    const trimmed = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (trimmed.length === 0) return;
    const lineNumber = ctx.increment();
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      ctx.incrementNonJson();
      ctx.writeChildSession({ type: 'raw', lineNumber, line: trimmed });
      return;
    }
    ctx.writeChildSession({ type: 'custom_message', lineNumber, payload: parsed });
    ctx.safeOnStream({
      kind: 'message',
      subagentId: ctx.subagentId,
      lineNumber,
      payload: parsed,
    });
  }

  // ── Settings ────────────────────────────────────────────────────────

  /** {@inheritDoc Harness.readSettings} */
  async readSettings(scope: HarnessScope): Promise<unknown> {
    const filePath = this.settingsPath(scope);
    if (!existsSync(filePath)) return {};
    const raw = await readFile(filePath, 'utf8');
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }

  /** {@inheritDoc Harness.writeSettings} */
  async writeSettings(patch: Record<string, unknown>, scope: HarnessScope): Promise<void> {
    const filePath = this.settingsPath(scope);
    const current = await this.readSettings(scope);
    const currentObj = isPlainObject(current) ? current : {};
    const merged = deepMerge(currentObj, patch);
    await atomicWriteJson(filePath, merged);
  }

  /** {@inheritDoc Harness.configureModels} */
  async configureModels(modelPatterns: string[], scope: HarnessScope): Promise<void> {
    await this.writeSettings({ enabledModels: modelPatterns }, scope);
  }

  // ── Wave-1 three-tier helpers ───────────────────────────────────────

  /**
   * Resolve the `models.json` path for a given legacy two-tier scope.
   *
   * @remarks
   * Lives next to `settings.json`. Global scope uses the Pi state root,
   * project scope uses the project's `.pi/` directory, matching the
   * dual-file authority model documented in ADR-035 §D3.
   */
  private modelsConfigPath(scope: HarnessScope): string {
    return scope.kind === 'global'
      ? join(getPiAgentDir(), 'models.json')
      : join(scope.projectDir, '.pi', 'models.json');
  }

  /**
   * Resolve the sessions directory — always user-tier because Pi owns
   * session storage and the three-tier model folds session listings to
   * the single authoritative location per ADR-035 §D2.
   */
  private sessionsDir(): string {
    return join(getPiAgentDir(), 'sessions');
  }

  // ── Extensions (Wave-1, T263) ───────────────────────────────────────

  /** {@inheritDoc Harness.installExtension} */
  async installExtension(
    sourcePath: string,
    name: string,
    tier: HarnessTier,
    projectDir?: string,
    opts?: HarnessInstallOptions,
  ): Promise<{ targetPath: string; tier: HarnessTier }> {
    if (!existsSync(sourcePath)) {
      throw new Error(`installExtension: source file does not exist: ${sourcePath}`);
    }
    const stats = await stat(sourcePath);
    if (!stats.isFile()) {
      throw new Error(`installExtension: source path is not a regular file: ${sourcePath}`);
    }

    const ext = extname(sourcePath);
    if (ext !== '.ts' && ext !== '.tsx' && ext !== '.mts') {
      throw new Error(
        `installExtension: expected a TypeScript source file (.ts/.tsx/.mts), got: ${ext || '(no extension)'}`,
      );
    }

    const contents = await readFile(sourcePath, 'utf8');
    if (!/\bexport\s+default\b/.test(contents)) {
      throw new Error(
        `installExtension: source file is missing an 'export default' — Pi extensions must export a default function`,
      );
    }

    const dir = resolveTierDir({ tier, kind: 'extensions', projectDir });
    const targetPath = join(dir, `${name}.ts`);

    if (existsSync(targetPath) && opts?.force !== true) {
      throw new Error(
        `installExtension: target already exists at ${targetPath} (pass --force to overwrite)`,
      );
    }

    await mkdir(dir, { recursive: true });
    await writeFile(targetPath, contents, 'utf8');
    return { targetPath, tier };
  }

  /** {@inheritDoc Harness.removeExtension} */
  async removeExtension(name: string, tier: HarnessTier, projectDir?: string): Promise<boolean> {
    const dir = resolveTierDir({ tier, kind: 'extensions', projectDir });
    const targetPath = join(dir, `${name}.ts`);
    if (!existsSync(targetPath)) return false;
    await rm(targetPath, { force: true });
    return true;
  }

  /** {@inheritDoc Harness.listExtensions} */
  async listExtensions(projectDir?: string): Promise<ExtensionEntry[]> {
    const tiers = resolveAllTiers('extensions', projectDir);
    const out: ExtensionEntry[] = [];
    const seenNames = new Set<string>();

    for (const { tier, dir } of tiers) {
      if (!existsSync(dir)) continue;
      let entries: Dirent[];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const fileName = entry.name;
        if (!fileName.endsWith('.ts')) continue;
        const name = fileName.slice(0, -'.ts'.length);
        const shadowed = seenNames.has(name);
        out.push({
          name,
          tier,
          path: join(dir, fileName),
          shadowed,
        });
        seenNames.add(name);
      }
    }

    return out;
  }

  // ── Sessions (Wave-1, T264) ─────────────────────────────────────────

  /** {@inheritDoc Harness.listSessions} */
  async listSessions(opts?: { includeSubagents?: boolean }): Promise<SessionSummary[]> {
    const rootDir = this.sessionsDir();
    if (!existsSync(rootDir)) return [];

    const files: string[] = [];

    // Top-level `*.jsonl` files.
    let rootEntries: Dirent[];
    try {
      rootEntries = await readdir(rootDir, { withFileTypes: true });
    } catch {
      return [];
    }
    for (const entry of rootEntries) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        files.push(join(rootDir, entry.name));
      }
    }

    // Subagents subdir (per ADR-035 §D6 session attribution convention).
    if (opts?.includeSubagents !== false) {
      const subDir = join(rootDir, 'subagents');
      if (existsSync(subDir)) {
        try {
          const subEntries = await readdir(subDir, { withFileTypes: true });
          for (const entry of subEntries) {
            if (entry.isFile() && entry.name.endsWith('.jsonl')) {
              files.push(join(subDir, entry.name));
            }
          }
        } catch {
          // Ignore — treat as empty.
        }
      }
    }

    const summaries: SessionSummary[] = [];
    for (const filePath of files) {
      const summary = await readSessionHeader(filePath);
      if (summary !== null) {
        summaries.push(summary);
      }
    }

    summaries.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return summaries;
  }

  /** {@inheritDoc Harness.showSession} */
  async showSession(id: string): Promise<SessionDocument> {
    const summaries = await this.listSessions({ includeSubagents: true });
    const match = summaries.find((s) => s.id === id);
    if (match === undefined) {
      throw new Error(`showSession: no session found with id ${id}`);
    }

    const raw = await readFile(match.filePath, 'utf8');
    const allLines = raw.split('\n');
    // Strip trailing empty lines (JSONL files often end with a newline).
    while (allLines.length > 0 && allLines[allLines.length - 1] === '') {
      allLines.pop();
    }
    // First line is the header (already in `match`); drop it from entries.
    const entries = allLines.slice(1);
    return { summary: match, entries };
  }

  // ── Models (Wave-1, T265) ───────────────────────────────────────────

  /** {@inheritDoc Harness.readModelsConfig} */
  async readModelsConfig(scope: HarnessScope): Promise<PiModelsConfig> {
    const filePath = this.modelsConfigPath(scope);
    if (!existsSync(filePath)) return { providers: {} };
    let raw: string;
    try {
      raw = await readFile(filePath, 'utf8');
    } catch {
      return { providers: {} };
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isPlainObject(parsed)) return { providers: {} };
      const providersField = parsed['providers'];
      if (!isPlainObject(providersField)) return { providers: {} };
      const providers: Record<string, PiModelProvider> = {};
      for (const [id, block] of Object.entries(providersField)) {
        if (isPlainObject(block)) {
          providers[id] = block as PiModelProvider;
        }
      }
      return { providers };
    } catch {
      return { providers: {} };
    }
  }

  /** {@inheritDoc Harness.writeModelsConfig} */
  async writeModelsConfig(config: PiModelsConfig, scope: HarnessScope): Promise<void> {
    const filePath = this.modelsConfigPath(scope);
    await atomicWriteJson(filePath, config);
  }

  /** {@inheritDoc Harness.listModels} */
  async listModels(scope: HarnessScope): Promise<ModelListEntry[]> {
    const models = await this.readModelsConfig(scope);
    const settings = await this.readSettings(scope);
    const settingsObj = isPlainObject(settings) ? settings : {};
    const enabledRaw = settingsObj['enabledModels'];
    const enabled = Array.isArray(enabledRaw)
      ? enabledRaw.filter((v): v is string => typeof v === 'string')
      : [];
    const defaultModel =
      typeof settingsObj['defaultModel'] === 'string' ? settingsObj['defaultModel'] : null;
    const defaultProvider =
      typeof settingsObj['defaultProvider'] === 'string' ? settingsObj['defaultProvider'] : null;

    const out: ModelListEntry[] = [];
    const seen = new Set<string>();

    // 1. Emit every custom model defined in models.json.
    for (const [providerId, providerBlock] of Object.entries(models.providers)) {
      const modelDefs = providerBlock.models ?? [];
      for (const def of modelDefs) {
        const key = `${providerId}:${def.id}`;
        seen.add(key);
        const isEnabled = enabled.includes(key) || enabled.includes(`${providerId}/*`);
        const isDefault = defaultProvider === providerId && defaultModel === def.id;
        out.push({
          provider: providerId,
          id: def.id,
          name: def.name ?? null,
          enabled: isEnabled,
          isDefault,
          custom: true,
        });
      }
    }

    // 2. Emit any enabled selection that was NOT already represented by a
    //    custom definition. These resolve against Pi's built-in registry.
    for (const selection of enabled) {
      // Skip glob-only patterns (no concrete model id).
      if (!selection.includes(':') && !selection.includes('/')) continue;
      // Parse "provider:model-id" or "provider/model-id".
      const match = selection.match(/^([^:/]+)[:/]([^:/].*)$/);
      if (match === null) continue;
      const provider = match[1];
      const id = match[2];
      if (provider === undefined || id === undefined) continue;
      if (id.endsWith('*')) continue; // glob, not a concrete id
      const key = `${provider}:${id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const isDefault = defaultProvider === provider && defaultModel === id;
      out.push({
        provider,
        id,
        name: null,
        enabled: true,
        isDefault,
        custom: false,
      });
    }

    // 3. Surface a bare default selection even if it is not in the
    //    enabled list (Pi treats `defaultModel` as authoritative).
    if (
      defaultProvider !== null &&
      defaultModel !== null &&
      !seen.has(`${defaultProvider}:${defaultModel}`)
    ) {
      out.push({
        provider: defaultProvider,
        id: defaultModel,
        name: null,
        enabled: false,
        isDefault: true,
        custom: false,
      });
    }

    return out;
  }

  // ── Prompts (Wave-1, T266) ──────────────────────────────────────────

  /** {@inheritDoc Harness.installPrompt} */
  async installPrompt(
    sourceDir: string,
    name: string,
    tier: HarnessTier,
    projectDir?: string,
    opts?: HarnessInstallOptions,
  ): Promise<{ targetPath: string; tier: HarnessTier }> {
    if (!existsSync(sourceDir)) {
      throw new Error(`installPrompt: source directory does not exist: ${sourceDir}`);
    }
    const stats = await stat(sourceDir);
    if (!stats.isDirectory()) {
      throw new Error(`installPrompt: source path is not a directory: ${sourceDir}`);
    }
    if (!existsSync(join(sourceDir, 'prompt.md'))) {
      throw new Error(`installPrompt: source directory is missing a prompt.md file: ${sourceDir}`);
    }

    const baseDir = resolveTierDir({ tier, kind: 'prompts', projectDir });
    const targetPath = join(baseDir, name);

    if (existsSync(targetPath)) {
      if (opts?.force !== true) {
        throw new Error(
          `installPrompt: target already exists at ${targetPath} (pass --force to overwrite)`,
        );
      }
      await rm(targetPath, { recursive: true, force: true });
    }

    await mkdir(baseDir, { recursive: true });
    await cp(sourceDir, targetPath, { recursive: true });
    return { targetPath, tier };
  }

  /** {@inheritDoc Harness.listPrompts} */
  async listPrompts(projectDir?: string): Promise<PromptEntry[]> {
    const tiers = resolveAllTiers('prompts', projectDir);
    const out: PromptEntry[] = [];
    const seenNames = new Set<string>();

    for (const { tier, dir } of tiers) {
      if (!existsSync(dir)) continue;
      let entries: Dirent[];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const name = entry.name;
        // Token-efficient list: NEVER read prompt bodies — only the
        // directory name is surfaced per ADR-035 spec hook T266.
        const shadowed = seenNames.has(name);
        out.push({
          name,
          tier,
          path: join(dir, name),
          shadowed,
        });
        seenNames.add(name);
      }
    }

    return out;
  }

  /** {@inheritDoc Harness.removePrompt} */
  async removePrompt(name: string, tier: HarnessTier, projectDir?: string): Promise<boolean> {
    const dir = resolveTierDir({ tier, kind: 'prompts', projectDir });
    const targetPath = join(dir, name);
    if (!existsSync(targetPath)) return false;
    await rm(targetPath, { recursive: true, force: true });
    return true;
  }

  // ── Themes (Wave-1, T267) ───────────────────────────────────────────

  /** {@inheritDoc Harness.installTheme} */
  async installTheme(
    sourceFile: string,
    name: string,
    tier: HarnessTier,
    projectDir?: string,
    opts?: HarnessInstallOptions,
  ): Promise<{ targetPath: string; tier: HarnessTier }> {
    if (!existsSync(sourceFile)) {
      throw new Error(`installTheme: source file does not exist: ${sourceFile}`);
    }
    const stats = await stat(sourceFile);
    if (!stats.isFile()) {
      throw new Error(`installTheme: source path is not a regular file: ${sourceFile}`);
    }
    const ext = extname(sourceFile);
    if (ext !== '.ts' && ext !== '.tsx' && ext !== '.mts' && ext !== '.json') {
      throw new Error(
        `installTheme: expected a theme file (.ts/.tsx/.mts/.json), got: ${ext || '(no extension)'}`,
      );
    }

    const dir = resolveTierDir({ tier, kind: 'themes', projectDir });
    const targetPath = join(dir, `${name}${ext}`);

    if (existsSync(targetPath) && opts?.force !== true) {
      throw new Error(
        `installTheme: target already exists at ${targetPath} (pass --force to overwrite)`,
      );
    }

    // Also block installing a .ts theme when a .json with the same stem
    // exists (and vice versa) unless force is set.
    const otherExts = ['.ts', '.tsx', '.mts', '.json'].filter((e) => e !== ext);
    for (const otherExt of otherExts) {
      const otherPath = join(dir, `${name}${otherExt}`);
      if (existsSync(otherPath) && opts?.force !== true) {
        throw new Error(
          `installTheme: conflicting theme exists at ${otherPath} (pass --force to overwrite both)`,
        );
      }
      if (existsSync(otherPath) && opts?.force === true) {
        await rm(otherPath, { force: true });
      }
    }

    await mkdir(dir, { recursive: true });
    const contents = await readFile(sourceFile);
    await writeFile(targetPath, contents);
    return { targetPath, tier };
  }

  /** {@inheritDoc Harness.listThemes} */
  async listThemes(projectDir?: string): Promise<ThemeEntry[]> {
    const tiers = resolveAllTiers('themes', projectDir);
    const out: ThemeEntry[] = [];
    const seenNames = new Set<string>();
    const validExts = new Set(['.ts', '.tsx', '.mts', '.json']);

    for (const { tier, dir } of tiers) {
      if (!existsSync(dir)) continue;
      let entries: Dirent[];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const fileExt = extname(entry.name);
        if (!validExts.has(fileExt)) continue;
        const name = entry.name.slice(0, -fileExt.length);
        const shadowed = seenNames.has(name);
        out.push({
          name,
          tier,
          path: join(dir, entry.name),
          fileExt,
          shadowed,
        });
        seenNames.add(name);
      }
    }

    return out;
  }

  /** {@inheritDoc Harness.removeTheme} */
  async removeTheme(name: string, tier: HarnessTier, projectDir?: string): Promise<boolean> {
    const dir = resolveTierDir({ tier, kind: 'themes', projectDir });
    let removed = false;
    for (const ext of ['.ts', '.tsx', '.mts', '.json']) {
      const targetPath = join(dir, `${name}${ext}`);
      if (existsSync(targetPath)) {
        await rm(targetPath, { force: true });
        removed = true;
      }
    }
    return removed;
  }

  // ── CANT profiles (Wave-1, T276) ────────────────────────────────────

  /**
   * {@inheritDoc Harness.installCantProfile}
   *
   * @remarks
   * Validates the source via {@link validateCantProfile} before copying so
   * we never persist a `.cant` file the runtime bridge cannot load. The
   * target layout is `<tier-root>/cant/<name>.cant`, resolved through
   * {@link resolveTierDir} so the project/user/global hierarchy stays
   * consistent with the other Wave-1 verbs.
   */
  async installCantProfile(
    sourcePath: string,
    name: string,
    tier: HarnessTier,
    projectDir?: string,
    opts?: HarnessInstallOptions,
  ): Promise<{ targetPath: string; tier: HarnessTier; counts: CantProfileCounts }> {
    if (!existsSync(sourcePath)) {
      throw new Error(`installCantProfile: source file does not exist: ${sourcePath}`);
    }
    const stats = await stat(sourcePath);
    if (!stats.isFile()) {
      throw new Error(`installCantProfile: source path is not a regular file: ${sourcePath}`);
    }

    const ext = extname(sourcePath);
    if (ext !== '.cant') {
      throw new Error(
        `installCantProfile: expected a CANT source file (.cant), got: ${ext || '(no extension)'}`,
      );
    }

    // Hard validation gate: refuse to install a profile cant-core rejects.
    const validation = await this.validateCantProfile(sourcePath);
    if (!validation.valid) {
      const firstError =
        validation.errors.find((e) => e.severity === 'error') ?? validation.errors[0];
      const detail =
        firstError !== undefined
          ? ` (${firstError.ruleId} at ${firstError.line}:${firstError.col}: ${firstError.message})`
          : '';
      throw new Error(`installCantProfile: source file failed cant-core validation${detail}`);
    }

    const dir = resolveTierDir({ tier, kind: 'cant', projectDir });
    const targetPath = join(dir, `${name}.cant`);

    if (existsSync(targetPath) && opts?.force !== true) {
      throw new Error(
        `installCantProfile: target already exists at ${targetPath} (pass --force to overwrite)`,
      );
    }

    const contents = await readFile(sourcePath);
    await mkdir(dir, { recursive: true });
    await writeFile(targetPath, contents);
    return { targetPath, tier, counts: validation.counts };
  }

  /** {@inheritDoc Harness.removeCantProfile} */
  async removeCantProfile(name: string, tier: HarnessTier, projectDir?: string): Promise<boolean> {
    const dir = resolveTierDir({ tier, kind: 'cant', projectDir });
    const targetPath = join(dir, `${name}.cant`);
    if (!existsSync(targetPath)) return false;
    await rm(targetPath, { force: true });
    return true;
  }

  /**
   * {@inheritDoc Harness.listCantProfiles}
   *
   * @remarks
   * Walks every tier in {@link TIER_PRECEDENCE} order, parsing each
   * discovered `.cant` file via cant-core to extract a
   * {@link CantProfileCounts} bag. Higher-precedence tiers shadow
   * lower-precedence entries with the same name; shadowed entries
   * still appear in the result but carry the
   * `shadowedByHigherTier` flag so callers can render the precedence
   * story without losing visibility of the duplicate.
   */
  async listCantProfiles(projectDir?: string): Promise<CantProfileEntry[]> {
    const tiers = resolveAllTiers('cant', projectDir);
    const out: CantProfileEntry[] = [];
    const seenNames = new Set<string>();

    for (const { tier, dir } of tiers) {
      if (!existsSync(dir)) continue;
      let entries: Dirent[];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const fileName = entry.name;
        if (!fileName.endsWith('.cant')) continue;
        const name = fileName.slice(0, -'.cant'.length);
        const sourcePath = join(dir, fileName);
        const counts = await extractCantCounts(sourcePath);
        const shadowed = seenNames.has(name);
        const profile: CantProfileEntry = {
          name,
          tier,
          sourcePath,
          counts,
        };
        if (shadowed) {
          profile.shadowedByHigherTier = true;
        }
        out.push(profile);
        seenNames.add(name);
      }
    }

    return out;
  }

  /**
   * {@inheritDoc Harness.validateCantProfile}
   *
   * @remarks
   * Pure validator. Reads the file, runs `parseDocument` to derive
   * counts (when parsing succeeds) and `validateDocument` to collect
   * the 42-rule diagnostic feed. The two calls are kept independent so
   * we can still report counts for files that pass parsing but fail a
   * lint rule.
   */
  async validateCantProfile(sourcePath: string): Promise<ValidateCantProfileResult> {
    if (!existsSync(sourcePath)) {
      throw new Error(`validateCantProfile: source file does not exist: ${sourcePath}`);
    }
    const stats = await stat(sourcePath);
    if (!stats.isFile()) {
      throw new Error(`validateCantProfile: source path is not a regular file: ${sourcePath}`);
    }

    const counts = await extractCantCounts(sourcePath);
    const validation = await validateDocument(sourcePath);
    const errors: CantValidationDiagnostic[] = validation.diagnostics.map((d) => ({
      ruleId: d.ruleId,
      message: d.message,
      line: d.line,
      col: d.col,
      severity: normaliseSeverity(d.severity),
    }));

    return {
      valid: validation.valid,
      errors,
      counts,
    };
  }
}

// ── Private subagent runtime helpers (ADR-035 §D6) ─────────────────────

/**
 * Terminate a child process via the canonical SIGTERM-then-SIGKILL
 * cleanup sequence used by {@link PiHarness.spawnSubagent}.
 *
 * @remarks
 * Sends SIGTERM, polls every 25 ms (or `min(graceMs, 25)` ms when the
 * grace window is shorter than the poll interval, to keep tests fast),
 * and escalates to SIGKILL once the grace window has elapsed if the
 * child is still alive. Tolerates a child that has already exited at
 * any point in the sequence — `child.kill` on a dead pid is a no-op.
 *
 * The promise resolves once the child has emitted `'close'` so callers
 * can be sure the cleanup is complete before continuing.
 */
async function terminateSubagent(child: ChildProcess, graceMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  try {
    child.kill('SIGTERM');
  } catch {
    // Already dead.
    return;
  }

  const pollInterval = Math.min(25, Math.max(1, graceMs));
  const deadline = Date.now() + graceMs;

  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      if (child.exitCode !== null || child.signalCode !== null) {
        clearInterval(timer);
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        clearInterval(timer);
        try {
          child.kill('SIGKILL');
        } catch {
          // Already dead.
        }
        resolve();
      }
    }, pollInterval);

    // Belt-and-braces: if 'close' fires before the polling tick, resolve
    // immediately so callers do not wait the full grace window.
    child.once('close', () => {
      clearInterval(timer);
      resolve();
    });
  });
}

/**
 * Append a {@link SubagentLinkEntry} to a parent session JSONL file.
 *
 * @remarks
 * Creates the parent directory if needed and uses an atomic
 * single-line append so the entry is well-formed under concurrent
 * writers. Throws on disk errors so the caller can record the failure
 * diagnostically; {@link PiHarness.spawnSubagent} catches the throw
 * and surfaces it via the stderr ring buffer rather than aborting the
 * spawn.
 */
async function writeSubagentLink(
  parentSessionPath: string,
  entry: SubagentLinkEntry,
): Promise<void> {
  await mkdir(dirname(parentSessionPath), { recursive: true });
  // Wrap the typed entry as a Pi `custom` JSONL entry. The original
  // `type` field is preserved as `subtype` so the parent session loader
  // can still discriminate `subagent_link` records when listing.
  const wrapped = {
    type: 'custom',
    subtype: entry.type,
    subagentId: entry.subagentId,
    taskId: entry.taskId,
    childSessionPath: entry.childSessionPath,
    startedAt: entry.startedAt,
  };
  const line = `${JSON.stringify(wrapped)}\n`;
  await appendFile(parentSessionPath, line, 'utf8');
}

// ── Private session-header helper ──────────────────────────────────────

/**
 * Read only the first line of a Pi session JSONL file and extract the
 * header summary.
 *
 * @remarks
 * Implements the ADR-035 §D2 rule that session listings MUST NOT read
 * past line 1. Uses a buffered file handle so we never pull more than
 * the first chunk off disk. Returns `null` when the file is empty,
 * unreadable, or its header is malformed — callers skip null entries.
 */
async function readSessionHeader(filePath: string): Promise<SessionSummary | null> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(filePath, 'r');
    const stats = await handle.stat();
    const capacity = Math.min(stats.size, 64 * 1024);
    if (capacity === 0) return null;
    const buffer = Buffer.alloc(capacity);
    const { bytesRead } = await handle.read(buffer, 0, capacity, 0);
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    const newlineIdx = text.indexOf('\n');
    const firstLine = newlineIdx === -1 ? text : text.slice(0, newlineIdx);
    if (firstLine.trim().length === 0) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(firstLine);
    } catch {
      return null;
    }
    if (!isPlainObject(parsed)) return null;
    const id = typeof parsed['id'] === 'string' ? parsed['id'] : null;
    if (id === null) {
      // Fall back to file stem if the header has no id — preserves the
      // file in the listing rather than dropping it silently.
      const stem = basename(filePath, '.jsonl');
      return {
        id: stem,
        version: typeof parsed['version'] === 'number' ? parsed['version'] : 0,
        timestamp: typeof parsed['timestamp'] === 'string' ? parsed['timestamp'] : null,
        cwd: typeof parsed['cwd'] === 'string' ? parsed['cwd'] : null,
        parentSession: typeof parsed['parentSession'] === 'string' ? parsed['parentSession'] : null,
        filePath,
        mtimeMs: stats.mtimeMs,
      };
    }

    return {
      id,
      version: typeof parsed['version'] === 'number' ? parsed['version'] : 0,
      timestamp: typeof parsed['timestamp'] === 'string' ? parsed['timestamp'] : null,
      cwd: typeof parsed['cwd'] === 'string' ? parsed['cwd'] : null,
      parentSession: typeof parsed['parentSession'] === 'string' ? parsed['parentSession'] : null,
      filePath,
      mtimeMs: stats.mtimeMs,
    };
  } catch {
    return null;
  } finally {
    if (handle !== null) {
      await handle.close().catch(() => {
        // Ignore close errors — we're already returning.
      });
    }
  }
}

// ── Private CANT helpers (T276) ────────────────────────────────────────

/** Empty count bag returned when parsing fails. */
const EMPTY_CANT_COUNTS: CantProfileCounts = {
  agentCount: 0,
  workflowCount: 0,
  pipelineCount: 0,
  hookCount: 0,
  skillCount: 0,
};

/**
 * Narrow a value to a record so we can safely walk the cant-core AST.
 */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Extract a string value from a cant-core spanned-name node.
 *
 * @remarks
 * Cant-core wraps identifiers/property keys in a `{ span, value }`
 * envelope. This helper unwraps the envelope or accepts a raw string,
 * returning `null` for anything else.
 */
function unwrapSpanned(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (isRecord(value) && typeof value['value'] === 'string') {
    return value['value'];
  }
  return null;
}

/**
 * Drill into a cant-core property `value` union and pull out the
 * declared skill names from a `skills:` array.
 *
 * @remarks
 * The cant-core AST encodes property values as discriminated objects
 * like `{ Array: [{ String: { raw: "ct-cleo" } }, ...] }` or
 * `{ Identifier: "name" }`. This helper walks just the shape used by
 * `skills: ["ct-cleo", "ct-task-executor"]` and pushes every string
 * literal into `out`. It is intentionally tolerant: anything that does
 * not match the expected shape is ignored rather than thrown.
 */
function collectSkillNames(value: unknown, out: Set<string>): void {
  if (!isRecord(value)) return;
  const arr = value['Array'];
  if (!Array.isArray(arr)) return;
  for (const item of arr) {
    if (!isRecord(item)) continue;
    const stringWrapper = item['String'];
    if (isRecord(stringWrapper) && typeof stringWrapper['raw'] === 'string') {
      out.add(stringWrapper['raw']);
      continue;
    }
    const identWrapper = item['Identifier'];
    if (typeof identWrapper === 'string') {
      out.add(identWrapper);
    }
  }
}

/**
 * Parse a `.cant` file and return its top-level section counts.
 *
 * @remarks
 * Used by both {@link PiHarness.listCantProfiles} and
 * {@link PiHarness.validateCantProfile}. Walks
 * `document.sections` (a tagged-union array where each element is a
 * single-key object such as `{ Agent: ... }`, `{ Workflow: ... }`,
 * `{ Pipeline: ... }`, `{ Hook: ... }`, `{ Comment: ... }`) and tallies
 * each section type. Hook bodies nested inside an Agent section's
 * `hooks` array are added to {@link CantProfileCounts.hookCount}, and
 * skill names referenced via the agent's `skills:` property are
 * de-duplicated into {@link CantProfileCounts.skillCount}.
 *
 * Returns the empty count bag when parsing fails — callers can still
 * surface the file in a list, just without per-section detail.
 */
async function extractCantCounts(sourcePath: string): Promise<CantProfileCounts> {
  let parsed: Awaited<ReturnType<typeof parseDocument>>;
  try {
    parsed = await parseDocument(sourcePath);
  } catch {
    return { ...EMPTY_CANT_COUNTS };
  }
  if (!parsed.success || !isRecord(parsed.document)) {
    return { ...EMPTY_CANT_COUNTS };
  }
  const sections = parsed.document['sections'];
  if (!Array.isArray(sections)) {
    return { ...EMPTY_CANT_COUNTS };
  }

  let agentCount = 0;
  let workflowCount = 0;
  let pipelineCount = 0;
  let hookCount = 0;
  const skillNames = new Set<string>();

  for (const section of sections) {
    if (!isRecord(section)) continue;
    if (isRecord(section['Agent'])) {
      agentCount += 1;
      const agent = section['Agent'];
      const hooks = agent['hooks'];
      if (Array.isArray(hooks)) {
        hookCount += hooks.length;
      }
      const properties = agent['properties'];
      if (Array.isArray(properties)) {
        for (const prop of properties) {
          if (!isRecord(prop)) continue;
          const key = unwrapSpanned(prop['key']);
          if (key === 'skills') {
            collectSkillNames(prop['value'], skillNames);
          }
        }
      }
      continue;
    }
    if (isRecord(section['Workflow'])) {
      workflowCount += 1;
      continue;
    }
    if (isRecord(section['Pipeline'])) {
      pipelineCount += 1;
      continue;
    }
    if (isRecord(section['Hook'])) {
      hookCount += 1;
    }
  }

  return {
    agentCount,
    workflowCount,
    pipelineCount,
    hookCount,
    skillCount: skillNames.size,
  };
}

/**
 * Normalise a cant-core severity string into the harness layer's typed
 * union.
 *
 * @remarks
 * Cant-core's native binding returns severity as a free-form string;
 * the harness contract types it as a closed union so downstream
 * envelope builders can safely render it. Unknown severities collapse
 * to `'error'` to fail closed.
 */
function normaliseSeverity(raw: string): 'error' | 'warning' | 'info' | 'hint' {
  if (raw === 'warning' || raw === 'info' || raw === 'hint') return raw;
  return 'error';
}
