/**
 * Explicit source ownership and per-repository revision observations.
 * Code placed in packages/core/ per Package-Boundary Check — verified against AGENTS.md.
 */
import { execFile } from 'node:child_process';
import { lstat, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';
import { promisify } from 'node:util';
import type {
  GraphSourceRoot,
  GraphSourceRootAssessment,
  GraphSourceRootRequest,
} from '@cleocode/contracts/graph';

const execFileAsync = promisify(execFile);

/** Freeze nested diagnostics as well as the root record. */
function freezeRoot(root: GraphSourceRoot): GraphSourceRoot {
  return Object.freeze({ ...root, diagnostics: Object.freeze([...root.diagnostics]) });
}

/** Missing paths are distinct from permission or other I/O failures. */
function missing(error: Error): boolean {
  return 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}

/** Preserve a missing configured path for its explicit diagnostic record. */
async function canonicalOrRequested(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (error instanceof Error && missing(error)) return path;
    throw error;
  }
}

/** Observe one root using its own Git worktree rather than an ancestor or ambient Git pin. */
async function observeRoot(
  requestedPath: string,
  graphPrefix: string,
  request: GraphSourceRootRequest,
  deadline: number,
  gitEnv: NodeJS.ProcessEnv,
): Promise<GraphSourceRoot> {
  let canonicalPath: string | null = null;
  const result = (
    status: GraphSourceRoot['status'],
    diagnostics: string[],
    revision: string | null = null,
  ): GraphSourceRoot =>
    freezeRoot({
      requestedPath,
      canonicalPath,
      graphPrefix,
      explicitlyIncluded: graphPrefix !== '',
      revision,
      status,
      diagnostics,
    });
  const pending = (): GraphSourceRoot =>
    result('pending', ['Source-root observation exceeded its shared deadline.']);
  request.signal?.throwIfAborted();
  if (Date.now() >= deadline) return pending();
  try {
    canonicalPath = await realpath(requestedPath);
  } catch (error) {
    request.signal?.throwIfAborted();
    return result(error instanceof Error && missing(error) ? 'missing' : 'failed', [
      `Cannot observe configured source root: ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }
  if (graphPrefix && canonicalPath !== requestedPath)
    throw new Error(`Ambiguous symlink ownership for included repository: ${graphPrefix}`);
  request.signal?.throwIfAborted();
  if (Date.now() >= deadline) return pending();
  try {
    if (!(await stat(canonicalPath)).isDirectory())
      return result('failed', ['Configured source root is not a directory.']);
  } catch (error) {
    request.signal?.throwIfAborted();
    return result(error instanceof Error && missing(error) ? 'missing' : 'failed', [
      `Cannot inspect configured source directory: ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }
  try {
    const marker = await lstat(join(canonicalPath, '.git'));
    if (marker.isSymbolicLink())
      return result('failed', ['Git metadata marker has ambiguous symlink ownership.']);
  } catch (error) {
    request.signal?.throwIfAborted();
    if (error instanceof Error && missing(error)) {
      return result(graphPrefix ? 'failed' : 'unversioned', [
        graphPrefix
          ? 'Explicitly included root has no Git worktree marker.'
          : 'Identity/source root is not a Git repository; included repositories retain their own revisions.',
      ]);
    }
    return result('failed', [
      `Cannot inspect Git metadata: ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }
  if (Date.now() >= deadline) return pending();
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel', 'HEAD'], {
      cwd: canonicalPath,
      env: gitEnv,
      signal: request.signal,
      timeout: Math.max(1, Math.min(1000, deadline - Date.now())),
      killSignal: 'SIGKILL',
      maxBuffer: 64 * 1024,
    });
    request.signal?.throwIfAborted();
    const lines = stdout.trimEnd().split('\n');
    if (lines.length !== 2 || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(lines[1])) {
      return result('failed', ['Git returned invalid repository/revision provenance.']);
    }
    if ((await realpath(lines[0])) !== canonicalPath)
      return result('failed', [
        'Git root differs from explicitly configured ownership; ancestor repositories are not included implicitly.',
      ]);
    if (Date.now() >= deadline) return pending();
    return result('available', [], lines[1]);
  } catch (error) {
    request.signal?.throwIfAborted();
    if (Date.now() >= deadline) return pending();
    return result('failed', [
      `Git revision observation failed: ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }
}

/**
 * Resolve explicitly owned repositories without replacing the stable parent project identity.
 * @param input - Parent identity, configured graph source and explicit included roots.
 * @returns A deeply frozen observation with each root's revision or diagnostic.
 * @remarks Escaping paths, duplicate ownership and included symlinks reject the request.
 * Missing roots and Git failures remain inspectable. No nested repository is discovered
 * implicitly. The shared deadline bounds Git subprocesses and checks filesystem phases;
 * it does not preempt filesystem I/O. This helper neither opens stores nor changes bindings.
 * @example
 * ```ts
 * const roots = await resolveSourceRoots({ projectId: 'stable-id', projectRoot: '/project', includedRepositories: ['app'] });
 * ```
 */
export async function resolveSourceRoots(
  input: GraphSourceRootRequest,
): Promise<GraphSourceRootAssessment> {
  const request = { ...input, includedRepositories: [...(input.includedRepositories ?? [])] };
  const gitEnv = { ...process.env };
  for (const key of Object.keys(gitEnv)) if (key.startsWith('GIT_')) delete gitEnv[key];
  gitEnv.GIT_OPTIONAL_LOCKS = '0';
  if (!request.projectId.trim()) throw new Error('Stable parent project identity is required.');
  request.signal?.throwIfAborted();
  const deadline = request.deadline ?? Date.now() + 2000;
  if (!Number.isFinite(deadline)) throw new Error('Source-root deadline must be finite.');
  const assessedAt = new Date().toISOString();
  const projectRoot = await canonicalOrRequested(resolve(request.projectRoot));
  const sourceRoot = await canonicalOrRequested(resolve(request.sourceRoot ?? projectRoot));

  const configured = [{ requestedPath: sourceRoot, graphPrefix: '' }];
  const seen = new Set([sourceRoot]);
  for (const included of request.includedRepositories ?? []) {
    if (!included || isAbsolute(included) || win32.isAbsolute(included))
      throw new Error(`Included repository must be a nonempty relative path: ${included}`);
    const requestedPath = resolve(sourceRoot, included);
    const local = relative(sourceRoot, requestedPath);
    if (local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local))
      throw new Error(`Included repository escapes source ownership: ${included}`);
    if (seen.has(requestedPath)) throw new Error(`Duplicate source ownership: ${included}`);
    seen.add(requestedPath);
    configured.push({ requestedPath, graphPrefix: local.split(sep).join('/') });
  }
  const roots: GraphSourceRoot[] = [];
  for (const root of configured)
    roots.push(await observeRoot(root.requestedPath, root.graphPrefix, request, deadline, gitEnv));
  return Object.freeze({
    projectId: request.projectId,
    projectRoot,
    sourceRoot,
    assessedAt,
    roots: Object.freeze(roots),
  });
}
