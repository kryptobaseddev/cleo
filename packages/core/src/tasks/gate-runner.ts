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
 *   - Gates run sequentially under the original shared deadline (two seconds by default).
 *   - Per-gate timeouts can only tighten the shared deadline. Long work needs runtime admission.
 *   - Structured test-count evidence and HTTP service startup require separate capabilities.
 *   - Results are observations; this module does not persist completion authority.
 *
 * @epic T760
 * @task T781
 */

import { createHash } from 'node:crypto';
import { open, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type {
  AcceptanceGate,
  AcceptanceGateResult,
  CommandGate,
  FileAssertion,
  FileGate,
  HttpGate,
  LintGate,
  ManualGate,
  TestGate,
} from '@cleocode/contracts';
import { acceptanceGateSchema } from '@cleocode/contracts';
import type { AcceptanceGateRunOptions } from '@cleocode/contracts/acceptance-gate';
import type {
  ProcessCaptureOptions,
  ProcessCaptureResult,
} from '@cleocode/contracts/resource-governor';
import { getProjectRoot } from '../paths.js';
import { captureProjectScope, worktreeScope } from '../project-scope.js';
import { truncateString } from '../render/helpers.js';
import { captureWrapped } from '../resources/spawn-wrapper.js';
import { createAttachmentStore } from '../store/attachment-store.js';
import { registerTeardownAbort } from '../teardown-signal.js';
import { heavyToolEnv } from './heavy-tool-env.js';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Default gate timeout in milliseconds. Overridden by env or per-gate `timeoutMs`. */
const DEFAULT_TIMEOUT_MS = Number(process.env['CLEO_GATE_TIMEOUT_MS'] ?? 60_000);

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
  const snapshot = structuredClone(gates);
  const controller = new AbortController();
  const deregister = registerTeardownAbort(controller);
  const batch: ProcessCaptureOptions = {
    cwd: projectRoot,
    env: { ...(options.env ?? process.env) },
    execution: {
      deadlineAt: execution?.deadlineAt ?? Date.now() + 2000,
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
          results.push(await runOneGate(parsed, i, projectRoot, options.skipManual ?? true, batch));
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
): Promise<AcceptanceGateResult> {
  const timeout = gate.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1)
    throw new Error('Gate timeout must be a positive safe integer');

  switch (gate.kind) {
    case 'test':
      return runTestGate(gate, index, projectRoot, timeout, context);
    case 'file':
      return runFileGate(gate, index, projectRoot, context);
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

/** Execute a process gate through the existing captured resource service. */
async function captureGateCommand(
  command: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
  context: ProcessCaptureOptions,
  overlay?: Readonly<Record<string, string>>,
): Promise<ProcessCaptureResult> {
  const env = { ...context.env, ...overlay };
  return captureWrapped(command, args, {
    ...context,
    cwd,
    env: { ...env, ...heavyToolEnv('test', env) },
    execution: {
      ...context.execution,
      deadlineAt: Math.min(context.execution.deadlineAt, Date.now() + timeoutMs),
    },
  });
}

/** Preserve target failure independently from launch, cancellation and cleanup failures. */
function processGateResult(
  index: number,
  gate: AcceptanceGate,
  captured: ProcessCaptureResult,
  verdict: 'pass' | 'fail',
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

async function runTestGate(
  gate: TestGate,
  index: number,
  projectRoot: string,
  timeoutMs: number,
  context: ProcessCaptureOptions,
): Promise<AcceptanceGateResult> {
  if (gate.minCount !== undefined && gate.minCount > 0)
    throw new Error(
      'Minimum test count requires a supported structured count result; exit0 alone cannot prove it',
    );
  const [command, ...defaults] = gate.command.trim().split(/\s+/);
  const captured = await captureGateCommand(
    command!,
    gate.args ?? defaults,
    resolveCwd(projectRoot, gate.cwd),
    timeoutMs,
    context,
    gate.env,
  );
  const passed =
    captured.exitCode === 0 &&
    (gate.expect === 'exit0' || !/\bFAIL\b|failing|Error:/i.test(captured.stdout));
  return processGateResult(
    index,
    gate,
    captured,
    passed ? 'pass' : 'fail',
    captured.exitCode === 0
      ? 'Failure pattern detected in output'
      : `Exit code ${captured.exitCode}`,
  );
}

// ─── File gate ────────────────────────────────────────────────────────────────

async function runFileGate(
  gate: FileGate,
  index: number,
  projectRoot: string,
  context: ProcessCaptureOptions,
): Promise<AcceptanceGateResult> {
  const startMs = Date.now();

  let attachmentBytes: Buffer | undefined;
  let filePath: string;
  if (gate.attachmentSha256) {
    const store = createAttachmentStore();
    const metadata = await store.getMetadata(gate.attachmentSha256, projectRoot);
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
    const result = await store.get(gate.attachmentSha256, projectRoot);
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
  const captured = await captureGateCommand(
    gate.cmd,
    gate.args ?? [],
    resolveCwd(projectRoot, gate.cwd),
    timeoutMs,
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

/** Tool-specific CLI arguments and failure patterns. */
const LINT_TOOL_DEFAULTS: Record<
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
  const captured = await captureGateCommand(
    tool.cmd,
    gate.args ?? tool.defaultArgs,
    resolveCwd(projectRoot, gate.cwd),
    timeoutMs,
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
