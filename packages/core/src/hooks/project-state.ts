/** Lightweight Git checkout resolution and hash-bound local activation (T13343). */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { access, lstat, realpath, stat } from 'node:fs/promises';
import { delimiter, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  type HookActivation,
  type ProjectHookContext,
  type ProjectHookDefinition,
  type ProjectHookInspection,
  type ProjectHookResolution,
  type ProjectHooksLocalState,
  ProjectHooksLocalStateSchema,
  type ProjectHooksManifest,
  ProjectHooksManifestSchema,
} from '@cleocode/contracts/project-hooks.js';
import { discoveryEnv } from '../git/work-tree.js';
import { atomicWrite } from '../store/atomic.js';
import { canonicalizePath, readFileText } from '../tools/fs.js';

const MAX_DEFINITION_BYTES = 262144;
const MAX_ACTIVATION_BYTES = 1048576;
const LOCKFILES = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lock', 'bun.lockb'];

/** Read a hook definition or private record with a hard allocation bound, including racing growth. */
export async function readProjectHookRecord(path: string, maxBytes: number): Promise<string> {
  return (await readFileText({ path, maxBytes })).content;
}

/** Resolve checkout and hook paths through Git without reading CLEO stores. */
export function resolveProjectHookContext(cwd: string): ProjectHookContext {
  const gitPath = (...args: string[]): string =>
    execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      env: discoveryEnv(),
      timeout: 5000,
      maxBuffer: 16384,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  const projectRoot = gitPath('rev-parse', '--show-toplevel');
  return {
    projectRoot,
    gitCommonDir: resolve(cwd, gitPath('rev-parse', '--path-format=absolute', '--git-common-dir')),
    hooksDir: resolve(cwd, gitPath('rev-parse', '--path-format=absolute', '--git-path', 'hooks')),
    stateDir: resolve(
      cwd,
      gitPath('rev-parse', '--path-format=absolute', '--git-path', 'cleo-project-hooks'),
    ),
  };
}

/** Resolve a real path inside this checkout, refusing symlink escapes. */
export async function resolveProjectHookFile(root: string, file: string): Promise<string> {
  const canonicalRoot = await realpath(root);
  const target = await canonicalizePath(resolve(root, file));
  const rel = relative(canonicalRoot, target);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`))
    // @sync-invariant none:local-only Reject unsafe machine-local hook records or executable inputs; no synced rows are written.
    throw new Error('HOOK_PATH_ESCAPE');
  return target;
}

/** Read a bounded tracked definition and reject malformed or duplicate entries. */
export async function readProjectHooksManifest(
  context: ProjectHookContext,
): Promise<ProjectHooksManifest> {
  const path = await resolveProjectHookFile(context.projectRoot, '.cleo/hooks.json');
  let body: string;
  try {
    body = await readProjectHookRecord(path, MAX_DEFINITION_BYTES);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return { schemaVersion: 1, hooks: [] };
    throw error;
  }
  return ProjectHooksManifestSchema.parse(JSON.parse(body));
}

/** Resolve a shell-free executable; project executable paths must remain inside checkout. */
export async function resolveProjectHookExecutable(
  root: string,
  executable: string,
): Promise<string> {
  if (isAbsolute(executable) || executable.includes('\0'))
    // @sync-invariant none:local-only Reject unsafe machine-local hook records or executable inputs; no synced rows are written.
    throw new Error('HOOK_EXECUTABLE_INVALID');
  if (executable.includes('/') || executable.includes('\\')) {
    const file = await resolveProjectHookFile(root, executable);
    await access(file, constants.X_OK);
    return file;
  }
  for (const path of (process.env.PATH ?? '').split(delimiter)) {
    if (!isAbsolute(path)) continue;
    const candidate = join(path, executable);
    try {
      await access(candidate, constants.X_OK);
      if ((await stat(candidate)).isFile()) return await realpath(candidate);
    } catch {
      /* Continue searching trusted absolute PATH entries. */
    }
  }
  // @sync-invariant none:local-only Reject unsafe machine-local hook records or executable inputs; no synced rows are written.
  throw new Error('HOOK_EXECUTABLE_MISSING');
}

function digest(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

async function digestFile(path: string, deadline: number, signal?: AbortSignal): Promise<string> {
  const remaining = Math.floor(deadline - performance.now());
  // @sync-invariant none:local-only Reject unsafe machine-local hook records or executable inputs; no synced rows are written.
  if (remaining <= 0) throw new Error('HOOK_HASH_TIMEOUT');
  const hash = createHash('sha256');
  let bytes = 0;
  const timeout = AbortSignal.timeout(remaining);
  const stream = createReadStream(path, {
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  for await (const chunk of stream) {
    bytes += chunk.length;
    if (bytes > 268435456) {
      stream.destroy();
      // @sync-invariant none:local-only Reject unsafe machine-local hook records or executable inputs; no synced rows are written.
      throw new Error('HOOK_DEPENDENCY_TOO_LARGE');
    }
    hash.update(chunk);
  }
  return hash.digest('hex');
}

async function projectIdentity(
  context: ProjectHookContext,
  deadline: number,
  signal?: AbortSignal,
): Promise<string> {
  try {
    const file = await resolveProjectHookFile(context.projectRoot, '.cleo/project.json');
    return await digestFile(file, deadline, signal);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    return digest(context.gitCommonDir);
  }
}

/** Compute the executable inputs bound by explicit activation. */
export async function computeHookActivation(
  context: ProjectHookContext,
  manifest: ProjectHooksManifest,
  deadline = performance.now() + 120000,
  signal?: AbortSignal,
): Promise<HookActivation> {
  const files: Record<string, string> = {};
  const executables: Record<string, string> = {};
  const inputs = new Set(
    manifest.hooks.flatMap((hook) => [
      hook.handler,
      ...hook.dependencies,
      ...(hook.executable.includes('/') ? [hook.executable] : []),
    ]),
  );
  for (const file of LOCKFILES) {
    try {
      await access(join(context.projectRoot, file));
      inputs.add(file);
    } catch {
      /* Absent optional lockfiles are not executable dependencies. */
    }
  }
  for (const file of [...inputs].sort()) {
    const path = await resolveProjectHookFile(context.projectRoot, file);
    // @sync-invariant none:local-only Reject unsafe machine-local hook records or executable inputs; no synced rows are written.
    if (!(await stat(path)).isFile()) throw new Error('HOOK_DEPENDENCY_NOT_FILE');
    files[file] = await digestFile(path, deadline, signal);
  }
  const executableHashes = new Map<string, string>();
  for (const hook of manifest.hooks) {
    const path = await resolveProjectHookExecutable(context.projectRoot, hook.executable);
    let hash = executableHashes.get(path);
    if (!hash) {
      hash = await digestFile(path, deadline, signal);
      executableHashes.set(path, hash);
    }
    // Project executables retain a checkout-relative identity across worktrees.
    // PATH runtimes bind the resolved system path and actual executable content.
    const identity = hook.executable.includes('/')
      ? relative(await realpath(context.projectRoot), path)
      : path;
    executables[hook.id] = `${identity}:${hash}`;
  }
  return {
    schemaVersion: 1,
    projectRoot: await realpath(context.projectRoot),
    projectIdentity: await projectIdentity(context, deadline, signal),
    manifestHash: digest(JSON.stringify(manifest)),
    files,
    executables,
    activatedAt: new Date().toISOString(),
  };
}

/** Resolve a private receipt path and reject redirected state directories or files. */
export async function resolveProjectHookStateFile(
  context: ProjectHookContext,
  name: string,
): Promise<string> {
  // @sync-invariant none:local-only Reject unsafe machine-local hook records or executable inputs; no synced rows are written.
  if (!/^[a-z-]+\.json$/.test(name)) throw new Error('HOOK_STATE_PATH_INVALID');
  const parent = await realpath(resolve(context.stateDir, '..'));
  const stateDir = await canonicalizePath(context.stateDir);
  if (relative(parent, stateDir) !== 'cleo-project-hooks')
    // @sync-invariant none:local-only Reject unsafe machine-local hook records or executable inputs; no synced rows are written.
    throw new Error('HOOK_STATE_PATH_ESCAPE');
  const path = join(stateDir, name);
  try {
    // @sync-invariant none:local-only Reject unsafe machine-local hook records or executable inputs; no synced rows are written.
    if ((await lstat(path)).isSymbolicLink()) throw new Error('HOOK_STATE_SYMLINK');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  return path;
}

/** Read machine-local feature state; no record means disabled. */
export async function readProjectHooksLocalState(
  context: ProjectHookContext,
): Promise<ProjectHooksLocalState> {
  const path = await resolveProjectHookStateFile(context, 'activation.json');
  try {
    return ProjectHooksLocalStateSchema.parse(
      JSON.parse(await readProjectHookRecord(path, MAX_ACTIVATION_BYTES)),
    );
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return { hooks: { project: { enabled: false } } };
    throw error;
  }
}

async function resolveDefinitions(
  context: ProjectHookContext,
  manifest: ProjectHooksManifest,
): Promise<ProjectHookResolution[]> {
  let sourceTracked = false;
  try {
    execFileSync(
      'git',
      ['-C', context.projectRoot, 'ls-files', '--error-unmatch', '--', '.cleo/hooks.json'],
      { timeout: 5000, maxBuffer: 16384, stdio: 'ignore' },
    );
    sourceTracked = true;
  } catch {
    /* Untracked local definitions may still be explicitly activated. */
  }
  return Promise.all(
    manifest.hooks.map(async (hook): Promise<ProjectHookResolution> => {
      const result: ProjectHookResolution = {
        id: hook.id,
        owner: hook.owner,
        sourceDefinition: join(context.projectRoot, '.cleo/hooks.json'),
        sourceTracked,
        diagnostics: [],
      };
      try {
        result.handlerPath = await resolveProjectHookFile(context.projectRoot, hook.handler);
      } catch {
        result.diagnostics.push('HOOK_HANDLER_PATH_UNAVAILABLE');
      }
      try {
        result.executablePath = await resolveProjectHookExecutable(
          context.projectRoot,
          hook.executable,
        );
      } catch {
        result.diagnostics.push('HOOK_EXECUTABLE_MISSING');
      }
      return result;
    }),
  );
}

/** Check that the explicit local approval still matches all declared code inputs. */
export async function inspectProjectHooks(
  cwd: string,
  deadline?: number,
  signal?: AbortSignal,
): Promise<ProjectHookInspection> {
  const context = resolveProjectHookContext(cwd);
  const manifest = await readProjectHooksManifest(context);
  const state = await readProjectHooksLocalState(context);
  const result: ProjectHookInspection = {
    context,
    manifest,
    resolvedHooks: await resolveDefinitions(context, manifest),
    enabled: state.hooks.project.enabled,
    activation: 'disabled',
    diagnostics: [],
    nativeTrust: 'unverified',
    nativeProjectTrust: 'unverified',
    nativeHookTrust: 'unverified',
  };
  if (!result.enabled) return result;
  if (!state.activation) {
    result.activation = 'missing';
    result.diagnostics.push('HOOK_ACTIVATION_MISSING');
    return result;
  }
  const current = await computeHookActivation(context, manifest, deadline, signal);
  const { activatedAt: _before, ...before } = state.activation;
  const { activatedAt: _after, ...after } = current;
  result.activation = JSON.stringify(before) === JSON.stringify(after) ? 'active' : 'drifted';
  if (result.activation === 'drifted') result.diagnostics.push('HOOK_REACTIVATION_REQUIRED');
  return result;
}

/** Explicitly activate the present definitions; does not install or grant harness trust. */
export async function activateProjectHooks(cwd: string): Promise<ProjectHooksLocalState> {
  const context = resolveProjectHookContext(cwd);
  const manifest = await readProjectHooksManifest(context);
  const activation = await computeHookActivation(context, manifest);
  const state: ProjectHooksLocalState = { hooks: { project: { enabled: true } }, activation };
  const serialized = `${JSON.stringify(state)}\n`;
  if (Buffer.byteLength(serialized) > MAX_ACTIVATION_BYTES)
    // @sync-invariant none:local-only Reject unsafe machine-local hook records or executable inputs; no synced rows are written.
    throw new Error('HOOK_ACTIVATION_TOO_LARGE');
  await resolveProjectHookStateFile(context, 'activation.json');
  const { withFileLock } = await import('../store/file-utils.js');
  await withFileLock(join(context.stateDir, 'activation.lock-target'), async () => {
    // Reassess under the writer lock; never approve a raced definition snapshot.
    const fresh = await computeHookActivation(context, await readProjectHooksManifest(context));
    const { activatedAt: _old, ...oldInputs } = activation;
    const { activatedAt: _new, ...newInputs } = fresh;
    if (JSON.stringify(oldInputs) !== JSON.stringify(newInputs))
      // @sync-invariant none:local-only Reject unsafe machine-local hook records or executable inputs; no synced rows are written.
      throw new Error('HOOK_ACTIVATION_RACED');
    await atomicWrite(await resolveProjectHookStateFile(context, 'activation.json'), serialized, {
      mode: 0o600,
    });
  });
  return state;
}

/** Disable machine-local execution without modifying project or native harness configuration. */
export async function disableProjectHooks(cwd: string): Promise<void> {
  const context = resolveProjectHookContext(cwd);
  await resolveProjectHookStateFile(context, 'activation.json');
  const { withFileLock } = await import('../store/file-utils.js');
  await withFileLock(join(context.stateDir, 'activation.lock-target'), async () =>
    atomicWrite(
      await resolveProjectHookStateFile(context, 'activation.json'),
      '{"hooks":{"project":{"enabled":false}}}\n',
      { mode: 0o600 },
    ),
  );
}

/** Match a project's binding without treating shell command text as a Git operation. */
export function matchesProjectHook(
  hook: ProjectHookDefinition,
  source: string,
  event: string,
): boolean {
  return hook.bindings.some((binding) => binding.source === source && binding.event === event);
}
