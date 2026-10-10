/** Lightweight project adapter hot path; types and Node only until invocation (T13344). */
import { readFile, stat } from 'node:fs/promises';
import type { HookJsonValue } from '@cleocode/contracts/heavy-command-hook.js';
import type { HookInvocation } from '@cleocode/contracts/project-hooks.js';
import type { HookIo } from './hook-entry.js';

const MAX_INPUT = 262144;
function processIo(): HookIo {
  return {
    cwd: process.cwd(),
    env: process.env,
    readStdin: async () => {
      const buffers: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of process.stdin) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
        bytes += buffer.length;
        if (bytes > MAX_INPUT) throw new Error('HOOK_INPUT_TOO_LARGE');
        buffers.push(buffer);
      }
      return Buffer.concat(buffers).toString('utf8');
    },
    writeStdout: (value) => {
      process.stdout.write(value);
    },
    writeStderr: (value) => {
      process.stderr.write(value);
    },
  };
}
/** Native invocation, always advisory for agents and fail-open for CLEO faults. */
export async function runProjectHookCli(
  argv: readonly string[],
  io: HookIo = processIo(),
): Promise<number> {
  if ((argv.indexOf('--') < 0 ? argv : argv.slice(0, argv.indexOf('--'))).includes('--probe')) {
    io.writeStdout('CLEO_PROJECT_HOOK_V1\n');
    return 0;
  }
  const controller = new AbortController();
  let terminationCode = 0;
  const interrupt = (): void => {
    terminationCode = 130;
    controller.abort();
    process.stdin.destroy();
  };
  const terminate = (): void => {
    terminationCode = 143;
    controller.abort();
    process.stdin.destroy();
  };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  try {
    const { normalizeNativeProjectHook, renderNativeProjectHook } = await import(
      '@cleocode/adapters/project-hook-native'
    );
    const request = normalizeNativeProjectHook(
      argv,
      await Promise.race([
        io.readStdin(),
        new Promise<string>((_, reject) => {
          if (controller.signal.aborted) {
            reject(new Error('HOOK_INTERRUPTED'));
            return;
          }
          controller.signal.addEventListener('abort', () => reject(new Error('HOOK_INTERRUPTED')), {
            once: true,
          });
        }),
      ]),
      io.cwd,
    );
    const { resolveProjectHookContext } = await import('@cleocode/core/hooks/project-state');
    const context = resolveProjectHookContext(request.cwd);
    const invocation: HookInvocation = {
      ...request.input,
      projectRoot: context.projectRoot,
      gitCommonDir: context.gitCommonDir,
    };
    const { executeProjectHooks } = await import('@cleocode/core/hooks/project-runner');
    const result = renderNativeProjectHook(
      request,
      await executeProjectHooks(invocation, undefined, undefined, controller.signal),
    );
    if (result.stdout) io.writeStdout(result.stdout);
    if (result.stderr) io.writeStderr(result.stderr);
    return terminationCode || result.exitCode;
  } catch {
    if (terminationCode) return terminationCode;
    io.writeStderr(
      '[cleo hook] project runner infrastructure failure; operation allowed. Run cleo doctor hooks.\n',
    );
    return 0;
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', terminate);
  }
}

/** Direct or CI check: LAFS output, with required unavailable checks failing CI. */
export async function checkProjectHookCli(
  id: string,
  source: 'direct' | 'ci',
  cwd: string,
  inputFile?: string,
  candidate?: string,
): Promise<void> {
  const { cliOutput, cliError } = await import('./renderers/index.js');
  try {
    const { resolveProjectHookContext } = await import('@cleocode/core/hooks/project-state');
    const context = resolveProjectHookContext(cwd);
    let toolInput: HookJsonValue = candidate ? { candidate } : {};
    if (inputFile) {
      if ((await stat(inputFile)).size > MAX_INPUT) throw new Error('HOOK_INPUT_TOO_LARGE');
      const content = await readFile(inputFile, 'utf8');
      if (Buffer.byteLength(content) > MAX_INPUT) throw new Error('HOOK_INPUT_TOO_LARGE');
      toolInput = JSON.parse(content) as HookJsonValue;
    }
    const { executeProjectHooks } = await import('@cleocode/core/hooks/project-runner');
    const outcomes = await executeProjectHooks(
      {
        schemaVersion: 1,
        projectRoot: context.projectRoot,
        gitCommonDir: context.gitCommonDir,
        source,
        event: 'check',
        toolInput,
      },
      id,
    );
    const failed =
      outcomes.length === 0 ||
      outcomes.some(
        (outcome) =>
          outcome.blocks ||
          outcome.status === 'infrastructure-error' ||
          (source === 'ci' && !['pass', 'skip'].includes(outcome.status)),
      );
    if (failed) {
      cliError(
        'Project hook did not satisfy the required check',
        'E_VALIDATION',
        { details: { outcomes } },
        { operation: 'hook.check' },
      );
      process.exitCode = 1;
    } else cliOutput({ outcomes }, { command: 'hook', operation: 'hook.check' });
  } catch {
    cliError(
      'Project hook infrastructure could not verify the required check',
      'E_VALIDATION',
      undefined,
      { operation: 'hook.check' },
    );
    process.exitCode = 1;
  }
}
