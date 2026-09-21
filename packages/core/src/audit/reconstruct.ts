/**
 * Bounded reconstruction from the local Git ledger, with explicit coverage.
 * Task proximity remains a heuristic, never authoritative containment.
 * @packageDocumentation
 */
import { resolve } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import type { CommitEntry, ReconstructResult } from '@cleocode/contracts';
import type { ReconstructAssessment, ReconstructOptions } from '@cleocode/contracts/audit';
import { resolveOrCwd } from '../paths.js';
import { worktreeScope } from '../project-scope.js';
import { extractTaskIds } from '../release/invariants/archive-reason-invariant.js';
import { captureWrapped } from '../resources/spawn-wrapper.js';

/**
 * Reconstruct exact task references and containing tags from bounded local Git reads.
 * @param taskId - Exact uppercase task token (for example T994), never a grep substring.
 * @param repoRoot - Explicit repository root, otherwise the captured caller scope or cwd.
 * @param options - Optional limits which cannot extend an inherited execution deadline.
 * @returns Existing lineage fields plus mandatory assessment coverage on every new result.
 * @remarks Reads commit messages and parents once, then propagates ancestry in topological
 * order. Git failures, truncated output, shallow history and cancellation are explicit.
 * No remote fetch or writes occur. Numeric child inference is retained for compatibility
 * and is not proof of task ownership. CPU stages yield cooperatively; this is not preemption.
 * @example
 * ```ts
 * const lineage = await reconstructLineage('T994', '/project', {});
 * if (lineage.assessment?.coverage !== 'current') return;
 * ```
 */
export async function reconstructLineage(
  taskId: string,
  repoRoot?: string,
  options: ReconstructOptions = {},
): Promise<ReconstructResult> {
  const inherited = worktreeScope.getStore();
  const root = resolve(resolveOrCwd(repoRoot ?? inherited?.worktreeRoot));
  const startedAt = Date.now();
  const caller = inherited?.execution;
  const deadlineAt = Math.min(
    caller?.deadlineAt ?? Infinity,
    options.execution?.deadlineAt ?? (caller ? Infinity : startedAt + 2000),
  );
  const signals = [caller?.signal, options.execution?.signal].filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );
  const signal = signals.length ? AbortSignal.any(signals) : undefined;
  const execution = { deadlineAt, signal };
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
  };
  // Explicit cwd owns this read, even when the caller was launched by another repository's hook.
  for (const name of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_COMMON_DIR',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_NAMESPACE',
    'GIT_SHALLOW_FILE',
  ])
    delete env[name];
  let remainingBytes = Math.min(
    options.maxOutputBytes ?? 8 * 1024 * 1024,
    caller?.resources.maxBytes ?? Infinity,
  );
  const assessment: ReconstructAssessment = {
    repositoryRoot: root,
    deadlineAt,
    coverage: 'failed',
    shallow: null,
    observedCommits: 0,
    historyComplete: false,
    tagsComplete: false,
    commands: [],
    diagnostics: [],
    limitations: [
      'Only locally reachable refs are assessed; no remote history is fetched.',
      'Numeric proximity and co-mentioned IDs suggest candidates, not authoritative child tasks.',
      'Refs may change during assessment; the reads are not an atomic repository snapshot.',
    ],
  };
  const result: ReconstructResult = {
    taskId,
    directCommits: [],
    childIdRange: null,
    childCommits: {},
    releaseTags: [],
    releaseCommitShas: [],
    firstSeenAt: null,
    lastSeenAt: null,
    inferredChildren: [],
    assessment,
  };
  const fail = (code: string, stage: string, message: string) => {
    assessment.diagnostics.push({ code, stage, message });
  };
  const active = (stage: string): boolean => {
    if (signal?.aborted) {
      fail(
        'E_OPERATION_CANCELLED',
        stage,
        'Original caller cancellation forbids further assessment.',
      );
      return false;
    }
    if (Date.now() >= deadlineAt) {
      fail('E_OPERATION_DEADLINE', stage, 'Original execution deadline has elapsed.');
      return false;
    }
    try {
      caller?.assertActive();
    } catch (error) {
      fail('E_OPERATION_INACTIVE', stage, error instanceof Error ? error.message : String(error));
      return false;
    }
    return true;
  };
  const git = async (stage: string, args: string[]): Promise<string | null> => {
    if (!active(stage)) return null;
    if (remainingBytes <= 0) {
      fail('E_OUTPUT_LIMIT', stage, 'Aggregate Git output byte budget exhausted.');
      return null;
    }
    try {
      const { stdout, ...receipt } = await captureWrapped('git', args, {
        cwd: root,
        env,
        execution,
        maxOutputBytes: remainingBytes,
      });
      assessment.commands.push({ ...receipt, args });
      const bytes = Buffer.byteLength(stdout) + Buffer.byteLength(receipt.stderr);
      remainingBytes -= bytes;
      caller?.consume({ bytes });
      if (
        !receipt.started ||
        receipt.exitCode !== 0 ||
        receipt.error ||
        receipt.stopped ||
        receipt.signal ||
        receipt.outputTruncated ||
        !receipt.targetCloseObserved ||
        receipt.cleanupErrors.length
      ) {
        fail(
          'E_GIT_READ_FAILED',
          stage,
          receipt.error ??
            receipt.stopped ??
            (receipt.stderr || `Git target did not complete cleanly (exit ${receipt.exitCode}).`),
        );
        return null;
      }
      if (!active(stage)) return null;
      return stdout;
    } catch (error) {
      fail('E_GIT_READ_FAILED', stage, error instanceof Error ? error.message : String(error));
      return null;
    }
  };
  if (
    !/^T\d+$/.test(taskId) ||
    !Number.isSafeInteger(deadlineAt) ||
    !Number.isSafeInteger(remainingBytes) ||
    remainingBytes < 0
  ) {
    fail('E_INVALID_INPUT', 'input', 'Task token, deadline and byte limit must be valid.');
    return result;
  }
  if (caller && resolve(caller.identity.projectRoot) !== root) {
    fail(
      'E_PROJECT_SCOPE_MISMATCH',
      'input',
      'Explicit repository differs from inherited operation ownership.',
    );
    return result;
  }
  const shallow = await git('repository', ['rev-parse', '--is-shallow-repository']);
  if (shallow === null) return result;
  if (!['true', 'false'].includes(shallow.trim())) {
    fail('E_GIT_PROTOCOL', 'repository', 'Git did not return a shallow-history verdict.');
    return result;
  }
  assessment.shallow = shallow.trim() === 'true';
  if (assessment.shallow)
    fail('E_SHALLOW_HISTORY', 'repository', 'Shallow history cannot establish complete lineage.');
  const history = await git('history', [
    'log',
    '--all',
    '--topo-order',
    '--no-show-signature',
    '--no-color',
    '--format=%H%x00%P%x00%an%x00%aI%x00%s%x00%B%x00',
  ]);
  if (history === null) return result;
  // Git messages cannot contain NUL. Newlines between records are not field delimiters.
  const fields = history.split('\0');
  if (fields.pop()?.trim() !== '' || fields.length % 6 !== 0) {
    fail('E_GIT_PROTOCOL', 'history', 'Malformed or incomplete commit fields.');
    return result;
  }
  const commits: CommitEntry[] = [];
  const parents = new Map<string, string[]>();
  const refs = new Map<string, string[]>();
  for (let i = 0; i < fields.length; i += 6) {
    if (i % 1536 === 0) {
      await setImmediate();
      if (!active('history-parse')) return result;
    }
    const sha = fields[i]!.trim();
    const parentIds = fields[i + 1]!.split(' ').filter(Boolean);
    if (!/^[a-f0-9]{40,64}$/.test(sha) || parentIds.some((id) => !/^[a-f0-9]{40,64}$/.test(id))) {
      fail('E_GIT_PROTOCOL', 'history', 'Malformed commit or parent identity.');
      return result;
    }
    try {
      caller?.consume({ items: 1 });
    } catch (error) {
      fail(
        'E_OPERATION_RESOURCE_LIMIT',
        'history-parse',
        error instanceof Error ? error.message : String(error),
      );
      return result;
    }
    commits.push({
      sha,
      author: fields[i + 2]!,
      authorDate: fields[i + 3]!,
      subject: fields[i + 4]!,
    });
    parents.set(sha, parentIds);
    refs.set(sha, extractTaskIds(fields[i + 5]!));
  }
  assessment.observedCommits = commits.length;
  assessment.historyComplete = true;
  assessment.coverage = 'partial';
  result.directCommits = commits.filter((commit) => refs.get(commit.sha)!.includes(taskId));
  const numericId = Number(taskId.slice(1));
  const candidates = new Set<string>();
  const directShas = new Set(result.directCommits.map((commit) => commit.sha));
  for (let i = 0; i < commits.length; i++) {
    if (i % 256 === 0) {
      await setImmediate();
      if (!active('task-matching')) return result;
    }
    const commit = commits[i]!;
    const radius = directShas.has(commit.sha) ? 50 : 20;
    for (const id of refs.get(commit.sha)!) {
      if (id !== taskId && Math.abs(Number(id.slice(1)) - numericId) <= radius) candidates.add(id);
    }
  }
  result.inferredChildren = [...candidates].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  if (result.inferredChildren.length)
    result.childIdRange = {
      min: result.inferredChildren[0]!,
      max: result.inferredChildren.at(-1)!,
    };
  const work = new Set(directShas);
  for (const id of result.inferredChildren) result.childCommits[id] = [];
  for (let index = 0; index < commits.length; index++) {
    if (index % 256 === 0) {
      await setImmediate();
      if (!active('child-matching')) return result;
    }
    const commit = commits[index]!;
    for (const id of refs.get(commit.sha)!) {
      if (candidates.has(id)) {
        result.childCommits[id]!.push(commit);
        work.add(commit.sha);
      }
    }
    if (work.has(commit.sha)) {
      if (result.firstSeenAt === null || commit.authorDate < result.firstSeenAt)
        result.firstSeenAt = commit.authorDate;
      if (result.lastSeenAt === null || commit.authorDate > result.lastSeenAt)
        result.lastSeenAt = commit.authorDate;
    }
  }
  // Reverse topological traversal visits parents before their descendants, including merges.
  const containsWork = new Set<string>();
  for (let i = commits.length - 1; i >= 0; i--) {
    if (i % 256 === 0) {
      await setImmediate();
      if (!active('ancestry')) return result;
    }
    const sha = commits[i]!.sha;
    const ancestors = parents.get(sha)!;
    if (ancestors.some((parent) => !parents.has(parent)))
      fail('E_MISSING_PARENT', 'ancestry', `Commit ${sha} references unavailable history.`);
    if (work.has(sha) || ancestors.some((parent) => containsWork.has(parent)))
      containsWork.add(sha);
  }
  const tags = await git('tags', [
    'for-each-ref',
    '--sort=refname',
    '--format=%(refname:strip=2)%00%(objecttype)%00%(objectname)%00%(*objecttype)%00%(*objectname)',
    'refs/tags',
  ]);
  if (tags === null) return result;
  const bySha = new Map(commits.map((commit) => [commit.sha, commit]));
  let validTags = true;
  const tagLines = tags.split('\n').filter(Boolean);
  for (let index = 0; index < tagLines.length; index++) {
    if (index % 256 === 0) await setImmediate();
    if (!active('tag-matching')) return result;
    const line = tagLines[index]!;
    const parts = line.split('\0');
    const [tag, type, object, peeledType, peeled] = parts;
    const target = type === 'commit' ? object : peeledType === 'commit' ? peeled : undefined;
    if (parts.length !== 5 || !tag || !object || (target && !bySha.has(target))) {
      fail(
        'E_GIT_PROTOCOL',
        'tags',
        `Tag ${tag ?? '(unknown)'} has missing or inconsistent commit evidence.`,
      );
      validTags = false;
      continue;
    }
    if (type === 'tag' && peeledType === 'tag') {
      fail(
        'E_UNSUPPORTED_TAG_CHAIN',
        'tags',
        `Nested tag ${tag} requires further authenticated peeling.`,
      );
      validTags = false;
      continue;
    }
    if (target && containsWork.has(target))
      result.releaseTags.push({
        tag,
        commitSha: target,
        subject: bySha.get(target)!.subject,
      });
  }
  result.releaseCommitShas = [...new Set(result.releaseTags.map((tag) => tag.commitSha))];
  assessment.tagsComplete = validTags;
  if (active('complete') && !assessment.diagnostics.length) assessment.coverage = 'current';
  return result;
}
