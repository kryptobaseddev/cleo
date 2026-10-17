/** Ordered project executor, separate from the best-effort internal registry (T13343). */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  type HookActivation,
  type HookExecutionReceipt,
  type HookExecutor,
  type HookInvocation,
  HookNativeSessionSchema,
  type HookOutcome,
  type HookOutcomeStatus,
  type ProjectHookBinding,
  type ProjectHookDefinition,
  ProjectHookVerdictSchema,
} from '@cleocode/contracts/project-hooks.js';
import { discoveryEnv } from '../git/work-tree.js';
import { atomicWrite } from '../store/atomic.js';
import {
  computeHookActivation,
  HookInputUnavailableError,
  hookBindingsDigest,
  inspectProjectHooks,
  matchesProjectHook,
  readProjectHookRecord,
  readProjectHooksLocalState,
  readProjectHooksManifest,
  resolveProjectHookContext,
  resolveProjectHookExecutable,
  resolveProjectHookFile,
  resolveProjectHookStateFile,
} from './project-state.js';
import { HOOKS_V1_UNRELEASED, hooksV1Released } from './release-gate.js';

const MAX_INPUT_BYTES = 65536;
const MAX_OUTPUT_BYTES = 65536;
const MAX_INVOCATION_MS = 120000;
const REACTIVATE =
  'Hook inputs changed since activation; review them, then run `cleo hook sync --activate`.';

/** Fixed-length per-binding slot; event text never becomes a filesystem path. */
function executionRecordName(binding: ProjectHookBinding): string {
  const hash = createHash('sha256').update(binding.event).digest('hex');
  return `last-execution-${binding.source}-${hash}.json`;
}

function fault(invocation: HookInvocation, code: string, id = 'cleo.project-hooks'): HookOutcome {
  return {
    id,
    status: 'infrastructure-error',
    blocks: invocation.source === 'ci',
    code,
    exitCode: null,
    signal: null,
    durationMs: 0,
  };
}

function sameInputs(left: HookActivation | undefined, right: HookActivation | undefined): boolean {
  return Boolean(
    left &&
      right &&
      left.projectIdentity === right.projectIdentity &&
      left.manifestHash === right.manifestHash &&
      JSON.stringify(left.files) === JSON.stringify(right.files) &&
      JSON.stringify(left.executables) === JSON.stringify(right.executables),
  );
}

function blocksFor(
  status: HookOutcomeStatus,
  hook: ProjectHookDefinition,
  invocation: HookInvocation,
): boolean {
  if (invocation.source === 'agent') return false;
  if (invocation.source === 'ci') return !['pass', 'skip'].includes(status);
  return (
    status === 'block' ||
    (['checker-error', 'timeout'].includes(status) && hook.checkerErrorPolicy === 'block')
  );
}

/**
 * Changed inputs never run (T13742): every approved, current or linked hook matching the event
 * fails closed for Git, worktree, direct and CI; agents only warn. An event none of them binds
 * runs no hooks, except for an activation recorded before bindings were stored, which refuses
 * it too. A direct check of an absent ID always refuses.
 */
function reactivationRequired(
  hooks: ReadonlyArray<Pick<ProjectHookDefinition, 'id' | 'bindings'>>,
  invocation: HookInvocation,
  id: string | undefined,
  approved: HookActivation | undefined,
): HookOutcome[] {
  const blocks = invocation.source !== 'agent';
  const ids = new Set(
    hooks
      .filter((hook) =>
        id ? hook.id === id : matchesProjectHook(hook, invocation.source, invocation.event),
      )
      .map((hook) => hook.id),
  );
  if (ids.size === 0 && !id && approvedBindings(approved)) return [];
  return [...(ids.size > 0 ? ids : [id ?? 'cleo.project-hooks'])].map((hookId) => ({
    id: hookId,
    status: blocks ? 'block' : 'warn',
    blocks,
    code: 'HOOK_REACTIVATION_REQUIRED',
    message: REACTIVATE,
    exitCode: null,
    signal: null,
    durationMs: 0,
  }));
}

/** Approved bindings whose digest verifies; a corrupted or pre-T13742 record has none. */
function approvedBindings(activation: HookActivation | undefined): HookActivation['bindings'] {
  const bindings = activation?.bindings;
  return bindings && activation?.bindingsHash === hookBindingsDigest(bindings)
    ? bindings
    : undefined;
}

/** Hooks as approved at activation. */
function approvedHooks(
  activation: HookActivation | undefined,
): Array<Pick<ProjectHookDefinition, 'id' | 'bindings'>> {
  return Object.entries(approvedBindings(activation) ?? {}).map(([id, bindings]) => ({
    id,
    bindings,
  }));
}

/**
 * A manifest that no longer parses, or a project input that can no longer be hashed, cannot
 * shed an approved hook (T13742): refuse the approved bindings. Returns undefined for every
 * other fault, which keeps its local allow behaviour.
 */
async function refuseUnverifiableInputs(
  error: Error | undefined,
  invocation: HookInvocation,
  id: string | undefined,
  activationRoot: string | undefined,
): Promise<HookOutcome[] | undefined> {
  try {
    const state = await readProjectHooksLocalState(
      resolveProjectHookContext(activationRoot ?? invocation.projectRoot),
    );
    if (!state.hooks.project.enabled || !state.activation || !hooksV1Released()) return undefined;
    if (error instanceof HookInputUnavailableError)
      return reactivationRequired(
        approvedHooks(state.activation),
        invocation,
        id,
        state.activation,
      );
    for (const root of new Set([invocation.projectRoot, activationRoot ?? invocation.projectRoot]))
      try {
        await readProjectHooksManifest(resolveProjectHookContext(root));
      } catch {
        return reactivationRequired(
          approvedHooks(state.activation),
          invocation,
          id,
          state.activation,
        );
      }
    return undefined;
  } catch {
    return undefined;
  }
}

async function executeOne(
  hook: ProjectHookDefinition,
  invocation: HookInvocation,
  remainingMs: number,
  signal?: AbortSignal,
): Promise<HookOutcome> {
  const started = performance.now();
  const outcome: HookOutcome = {
    id: hook.id,
    status: 'checker-error',
    blocks: false,
    code: 'HOOK_CHECKER_ERROR',
    exitCode: null,
    signal: null,
    durationMs: 0,
  };
  try {
    const executable = await resolveProjectHookExecutable(invocation.projectRoot, hook.executable);
    const handler = await resolveProjectHookFile(invocation.projectRoot, hook.handler);
    const payload = JSON.stringify(invocation);
    await new Promise<void>((complete) => {
      const child = spawn(executable, [handler, ...hook.args], {
        cwd: invocation.projectRoot,
        env: discoveryEnv(),
        shell: false,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let finished = false;
      const stdout: Buffer[] = [];
      let bytes = 0;
      let interrupted = false;
      let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = (): void => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (cleanupTimer) clearTimeout(cleanupTimer);
        signal?.removeEventListener('abort', onAbort);
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        complete();
      };
      const killGroup = (): void => {
        try {
          if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch {
          /* The child may already have exited. */
        }
      };
      const terminate = (): void => {
        interrupted = true;
        killGroup();
        outcome.signal = 'SIGKILL';
        cleanupTimer = setTimeout(finish, 250);
      };
      const onAbort = (): void => {
        outcome.status = 'infrastructure-error';
        outcome.code = 'HOOK_ABORTED';
        terminate();
      };
      const timer = setTimeout(
        () => {
          outcome.status = remainingMs < hook.timeoutMs ? 'infrastructure-error' : 'timeout';
          outcome.code = remainingMs < hook.timeoutMs ? 'HOOK_INVOCATION_TIMEOUT' : 'HOOK_TIMEOUT';
          terminate();
        },
        Math.min(hook.timeoutMs, remainingMs),
      );
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
      child.stdout.on('data', (chunk: Buffer) => {
        if (interrupted) return;
        bytes += chunk.length;
        if (bytes > MAX_OUTPUT_BYTES) {
          outcome.code = 'HOOK_OUTPUT_TOO_LARGE';
          terminate();
          return;
        }
        stdout.push(chunk);
      });
      // Never persist child stderr: it may contain secrets or arbitrary payloads.
      child.stderr.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (!interrupted && bytes > MAX_OUTPUT_BYTES) {
          outcome.code = 'HOOK_OUTPUT_TOO_LARGE';
          terminate();
        }
      });
      child.on('error', () => {
        outcome.status = 'infrastructure-error';
        outcome.code = 'HOOK_EXECUTION_FAILED';
        finish();
      });
      child.stdin.on('error', () => {
        /* close/error determines the verdict. */
      });
      child.on('exit', () => {
        // Stop descendants that remain in the checker process group after its verdict.
        killGroup();
      });
      child.on('close', (exitCode, signal) => {
        if (finished) return;
        outcome.exitCode = exitCode;
        outcome.signal = signal;
        if (!interrupted) {
          if (signal) outcome.code = 'HOOK_SIGNAL';
          else if (exitCode !== 0) outcome.code = 'HOOK_NONZERO_EXIT';
          else {
            try {
              const verdict = ProjectHookVerdictSchema.parse(
                JSON.parse(Buffer.concat(stdout).toString('utf8')),
              );
              outcome.status = verdict.status;
              if (verdict.message) outcome.message = verdict.message;
              outcome.code = `HOOK_${verdict.status.toUpperCase().replace('-', '_')}`;
            } catch {
              outcome.code = 'HOOK_INVALID_VERDICT';
            }
          }
        }
        finish();
      });
      child.stdin.end(payload);
    });
  } catch {
    outcome.status = 'infrastructure-error';
    outcome.code = 'HOOK_EXECUTION_UNAVAILABLE';
  }
  outcome.durationMs = Math.round(performance.now() - started);
  outcome.blocks = blocksFor(outcome.status, hook, invocation);
  return outcome;
}

/** Execute activated definitions in source order; internal faults always allow locally. */
export async function executeProjectHooks(
  invocation: HookInvocation,
  id?: string,
  activationRoot?: string,
  signal?: AbortSignal,
): Promise<HookOutcome[]> {
  const deadline = performance.now() + MAX_INVOCATION_MS;
  try {
    if (Buffer.byteLength(JSON.stringify(invocation)) > MAX_INPUT_BYTES)
      return [fault(invocation, 'HOOK_INPUT_TOO_LARGE')];
    const inspection = await inspectProjectHooks(
      activationRoot ?? invocation.projectRoot,
      deadline,
      signal,
    );
    const checkout = resolveProjectHookContext(invocation.projectRoot);
    if (
      checkout.gitCommonDir !== invocation.gitCommonDir ||
      checkout.projectRoot !== invocation.projectRoot ||
      checkout.gitCommonDir !== inspection.context.gitCommonDir
    ) {
      return [fault(invocation, 'HOOK_CHECKOUT_MISMATCH')];
    }
    if (
      activationRoot &&
      checkout.projectRoot !== inspection.context.projectRoot &&
      inspection.activation === 'active'
    ) {
      const targetManifest = await readProjectHooksManifest(checkout);
      const target = await computeHookActivation(checkout, targetManifest, deadline, signal);
      const state = await readProjectHooksLocalState(inspection.context);
      const approved = state.activation;
      // Inherit approval only for the same project and identical executable inputs.
      // A changed worktree definition or dependency always requires reactivation.
      if (
        !approved ||
        target.projectIdentity !== approved.projectIdentity ||
        target.manifestHash !== approved.manifestHash ||
        JSON.stringify(target.files) !== JSON.stringify(approved.files) ||
        JSON.stringify(target.executables) !== JSON.stringify(approved.executables)
      ) {
        return reactivationRequired(
          [...approvedHooks(approved), ...inspection.manifest.hooks, ...targetManifest.hooks],
          invocation,
          id,
          approved,
        );
      }
    }
    if (inspection.activation === 'unreleased') {
      // T13557: inert on a build without hooks-v1; a required CI check still fails.
      if (invocation.source === 'ci') return [fault(invocation, HOOKS_V1_UNRELEASED)];
      return [
        {
          id: id ?? 'cleo.project-hooks',
          status: 'skip',
          blocks: false,
          code: HOOKS_V1_UNRELEASED,
          exitCode: null,
          signal: null,
          durationMs: 0,
        },
      ];
    }
    if (inspection.activation !== 'active') {
      if (invocation.source === 'ci')
        return [fault(invocation, 'HOOK_REQUIRED_ACTIVATION_MISSING')];
      if (inspection.activation !== 'disabled') {
        const approved = (await readProjectHooksLocalState(inspection.context)).activation;
        // A linked checkout may bind hooks its drifted source no longer declares.
        const target =
          checkout.projectRoot === inspection.context.projectRoot
            ? []
            : await readProjectHooksManifest(checkout).then(
                (manifest) => manifest.hooks,
                () => [],
              );
        return reactivationRequired(
          [...approvedHooks(approved), ...inspection.manifest.hooks, ...target],
          invocation,
          id,
          approved,
        );
      }
      return [
        {
          id: id ?? 'cleo.project-hooks',
          status: 'skip',
          blocks: false,
          code: 'HOOK_DISABLED',
          exitCode: null,
          signal: null,
          durationMs: 0,
        },
      ];
    }
    const definitions = inspection.manifest.hooks.filter((hook) =>
      id ? hook.id === id : matchesProjectHook(hook, invocation.source, invocation.event),
    );
    if (id && definitions.length === 0) return [fault(invocation, 'HOOK_NOT_FOUND', id)];
    const outcomes: HookOutcome[] = [];
    const approved = (await readProjectHooksLocalState(inspection.context)).activation;
    for (const [index, hook] of definitions.entries()) {
      // Recheck between handlers: an earlier checker may have changed later code.
      const fresh = await readProjectHooksLocalState(inspection.context);
      const target = await computeHookActivation(
        checkout,
        await readProjectHooksManifest(checkout),
        deadline,
        signal,
      );
      if (
        !fresh.hooks.project.enabled ||
        !sameInputs(fresh.activation, approved) ||
        !sameInputs(target, approved)
      ) {
        outcomes.push(...reactivationRequired(definitions.slice(index), invocation, id, approved));
        break;
      }
      const remainingMs = Math.floor(deadline - performance.now());
      if (remainingMs <= 0) {
        outcomes.push({
          id: hook.id,
          status: 'infrastructure-error',
          blocks: invocation.source === 'ci',
          code: 'HOOK_INVOCATION_TIMEOUT',
          exitCode: null,
          signal: null,
          durationMs: MAX_INVOCATION_MS,
        });
        break;
      }
      if (signal?.aborted) {
        outcomes.push(fault(invocation, 'HOOK_ABORTED', hook.id));
        break;
      }
      outcomes.push(await executeOne(hook, invocation, remainingMs, signal));
    }
    // Last-result records are bounded and contain only executor-owned metadata.
    // Preserve the agent binding even when the subsequent Git hook records its result.
    // A failed receipt write is visible as infrastructure fault, never a fake pass.
    try {
      const nativeSession = invocation.nativeSession
        ? HookNativeSessionSchema.parse(invocation.nativeSession)
        : undefined;
      const receipt: HookExecutionReceipt = {
        schemaVersion: 1,
        ...nativeSession,
        manifestHash: approved?.manifestHash ?? '',
        source: invocation.source,
        event: invocation.event.slice(0, 128),
        recordedAt: new Date().toISOString(),
        outcomes: outcomes.map(({ message: _message, ...safe }) => safe),
      };
      const serialized = `${JSON.stringify(receipt)}\n`;
      await atomicWrite(
        await resolveProjectHookStateFile(inspection.context, executionRecordName(invocation)),
        serialized,
        { mode: 0o600 },
      );
      // Keep the existing overall-last diagnostic API compatible.
      await atomicWrite(
        await resolveProjectHookStateFile(inspection.context, 'last-execution.json'),
        serialized,
        { mode: 0o600 },
      );
    } catch {
      outcomes.push(fault(invocation, 'HOOK_RECEIPT_WRITE_FAILED'));
    }
    return outcomes;
  } catch (error) {
    return (
      (await refuseUnverifiableInputs(
        error instanceof Error ? error : undefined,
        invocation,
        id,
        activationRoot,
      )) ?? [fault(invocation, 'HOOK_INFRASTRUCTURE_ERROR')]
    );
  }
}

/** Contracts port for worktree and other consumers; no internal registry coupling. */
export const projectHookExecutor: HookExecutor = { execute: executeProjectHooks };

/** Bind worktree inheritance to an explicitly activated source checkout. */
export function createProjectHookExecutor(activationRoot: string): HookExecutor {
  return { execute: (invocation) => executeProjectHooks(invocation, undefined, activationRoot) };
}

/**
 * Read a bounded redacted execution record, validating its shape and optional binding.
 * @param cwd - Active checkout whose private receipts are inspected.
 * @param binding - Select a retained source/event result; omitted reads the overall latest result.
 * @returns The matching record, or undefined when absent, malformed or mismatched.
 */
export async function readLastProjectHookExecution(
  cwd: string,
  binding?: ProjectHookBinding,
): Promise<HookExecutionReceipt | undefined> {
  const inspection = await inspectProjectHooks(cwd);
  const file = await resolveProjectHookStateFile(
    inspection.context,
    binding ? executionRecordName(binding) : 'last-execution.json',
  );
  try {
    const { HookExecutionReceiptSchema } = await import('@cleocode/contracts/project-hooks.js');
    const receipt = HookExecutionReceiptSchema.parse(
      JSON.parse(await readProjectHookRecord(file, MAX_OUTPUT_BYTES)),
    );
    if (binding && (receipt.source !== binding.source || receipt.event !== binding.event))
      return undefined;
    return receipt;
  } catch {
    return undefined;
  }
}
