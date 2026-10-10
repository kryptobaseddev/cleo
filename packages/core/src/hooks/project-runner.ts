/** Ordered project executor, separate from the best-effort internal registry (T13343). */
import { spawn } from 'node:child_process';
import {
  type HookActivation,
  type HookExecutionReceipt,
  type HookExecutor,
  type HookInvocation,
  type HookOutcome,
  type HookOutcomeStatus,
  type ProjectHookDefinition,
  ProjectHookVerdictSchema,
} from '@cleocode/contracts/project-hooks.js';
import { atomicWrite } from '../store/atomic.js';
import {
  computeHookActivation,
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

const MAX_INPUT_BYTES = 65536;
const MAX_OUTPUT_BYTES = 65536;
const MAX_INVOCATION_MS = 120000;

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
      const target = await computeHookActivation(
        checkout,
        await readProjectHooksManifest(checkout),
        deadline,
        signal,
      );
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
        return [
          {
            id: id ?? 'cleo.project-hooks',
            status: 'warn',
            blocks: invocation.source === 'ci',
            code: 'HOOK_REACTIVATION_REQUIRED',
            exitCode: null,
            signal: null,
            durationMs: 0,
          },
        ];
      }
    }
    if (inspection.activation !== 'active') {
      if (invocation.source === 'ci')
        return [fault(invocation, 'HOOK_REQUIRED_ACTIVATION_MISSING')];
      return [
        {
          id: id ?? 'cleo.project-hooks',
          status: inspection.activation === 'disabled' ? 'skip' : 'warn',
          blocks: false,
          code:
            inspection.activation === 'disabled' ? 'HOOK_DISABLED' : 'HOOK_REACTIVATION_REQUIRED',
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
    for (const hook of definitions) {
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
        outcomes.push({
          id: hook.id,
          status: 'warn',
          blocks: invocation.source === 'ci',
          code: 'HOOK_REACTIVATION_REQUIRED',
          exitCode: null,
          signal: null,
          durationMs: 0,
        });
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
    // A last-result record is bounded and contains only executor-owned metadata.
    // A failed receipt write is visible as infrastructure fault, never a fake pass.
    try {
      const receipt: HookExecutionReceipt = {
        schemaVersion: 1,
        manifestHash: approved?.manifestHash ?? '',
        source: invocation.source,
        event: invocation.event.slice(0, 128),
        recordedAt: new Date().toISOString(),
        outcomes: outcomes.map(({ message: _message, ...safe }) => safe),
      };
      await atomicWrite(
        await resolveProjectHookStateFile(inspection.context, 'last-execution.json'),
        `${JSON.stringify(receipt)}\n`,
        { mode: 0o600 },
      );
    } catch {
      outcomes.push(fault(invocation, 'HOOK_RECEIPT_WRITE_FAILED'));
    }
    return outcomes;
  } catch {
    return [fault(invocation, 'HOOK_INFRASTRUCTURE_ERROR')];
  }
}

/** Contracts port for worktree and other consumers; no internal registry coupling. */
export const projectHookExecutor: HookExecutor = { execute: executeProjectHooks };

/** Bind worktree inheritance to an explicitly activated source checkout. */
export function createProjectHookExecutor(activationRoot: string): HookExecutor {
  return { execute: (invocation) => executeProjectHooks(invocation, undefined, activationRoot) };
}

/** Read only a bounded last execution record and validate its safe shape. */
export async function readLastProjectHookExecution(
  cwd: string,
): Promise<HookExecutionReceipt | undefined> {
  const inspection = await inspectProjectHooks(cwd);
  const file = await resolveProjectHookStateFile(inspection.context, 'last-execution.json');
  try {
    const { HookExecutionReceiptSchema } = await import('@cleocode/contracts/project-hooks.js');
    return HookExecutionReceiptSchema.parse(
      JSON.parse(await readProjectHookRecord(file, MAX_OUTPUT_BYTES)),
    );
  } catch {
    return undefined;
  }
}
