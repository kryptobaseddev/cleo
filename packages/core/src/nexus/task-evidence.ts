/**
 * Read historical task evidence through canonical stores and resolve file-level provenance.
 *
 * Code placed in `packages/core/` per Package-Boundary Check — verified
 * against AGENTS.md. Evidence discovery never rewrites historical verification.
 */

import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import type {
  KnowledgeCoverage,
  KnowledgeEvidenceRef,
  KnowledgeFileEvidence,
  TaskKnowledgeEvidence,
} from '@cleocode/contracts';
import { createAttachmentStore } from '../store/attachment-store.js';
import { getTaskAccessor } from '../store/data-accessor.js';
import {
  assessKnowledgeCoverage,
  readKnowledgeIndexAssessment,
  recordKnowledgeGap,
} from './knowledge.js';

const execFileAsync = promisify(execFile);

/**
 * Discover explicit file evidence, verification atoms, commits, and canonical attachments.
 * @param taskId - Task whose historical evidence should be resolved.
 * @param projectRoot - Canonical project root, independent of the configured source root.
 * @param existingCoverage - Optional shared assessment to enrich with evidence limitations.
 * @param deadline - Absolute assessment deadline; defaults to two seconds from invocation.
 * @returns Deduplicated file associations, provenance, and unresolved findings.
 * @remarks File evidence never establishes that every symbol in a file changed.
 * @example
 * ```ts
 * const footprint = await getTaskKnowledgeEvidence('T448', projectRoot, undefined, Date.now() + 2000);
 * ```
 */
export async function getTaskKnowledgeEvidence(
  taskId: string,
  projectRoot: string,
  existingCoverage?: KnowledgeCoverage,
  deadline = Date.now() + 2000,
): Promise<TaskKnowledgeEvidence> {
  const coverage =
    existingCoverage ??
    (await assessKnowledgeCoverage(projectRoot, undefined, Math.max(0, deadline - Date.now())));
  const result: TaskKnowledgeEvidence = {
    taskId,
    sourceRoot: projectRoot,
    files: [],
    coverage,
    findings: [],
  };
  const files = new Map<string, KnowledgeFileEvidence>();
  let sourceRoots = [projectRoot];
  const unresolved = (description: string, evidence: KnowledgeEvidenceRef[]): void => {
    recordKnowledgeGap(coverage, 'partial', description);
    result.findings.push({
      id: `task-evidence:${taskId}:${description}`,
      projectId: coverage.projectId,
      affectedRecordIds: [taskId],
      description,
      evidence,
      repairClass: 'agent-resolvable',
      state: 'unresolved',
      proposedAction: null,
      verification: ['Resolve the cited path or format using explicit source provenance.'],
      recovery: null,
    });
  };
  const remaining = (): number => Math.max(0, deadline - Date.now());
  const defer = (): void => {
    const reason =
      'Task evidence expansion deferred by the maintenance budget; remaining sources are unassessed.';
    if (!coverage.reasons.includes(reason)) unresolved(reason, []);
    coverage.maintenanceState = 'pending';
    coverage.nextAction = `cleo doctor knowledge --task ${taskId}`;
  };
  if (remaining() === 0) {
    defer();
    return result;
  }
  const reference = (
    id: string,
    source: KnowledgeEvidenceRef['source'],
    revision: string | null = null,
  ): KnowledgeEvidenceRef => ({
    id,
    projectId: coverage.projectId,
    source,
    revision,
    precision: 'file',
  });
  const addFile = (path: string, evidence: KnowledgeEvidenceRef): void => {
    const candidates = [...new Set(sourceRoots.map((root) => resolve(root, path)))].filter(
      (candidate) => {
        const relativePath = relative(result.sourceRoot, candidate);
        return (
          !relativePath.startsWith('..') &&
          !isAbsolute(relativePath) &&
          existsSync(candidate) &&
          statSync(candidate).isFile()
        );
      },
    );
    const resolvedPath = candidates.length === 1 ? candidates[0] : null;
    const key = resolvedPath ? relative(result.sourceRoot, resolvedPath) : path;
    if (candidates.length > 1) {
      unresolved(
        `Ambiguous evidence path ${path}; explicit included repositories match: ${candidates.map((candidate) => relative(result.sourceRoot, candidate)).join(', ')}`,
        [evidence],
      );
    }
    const entry = files.get(key);
    if (entry) {
      if (!entry.evidence.some((ref) => ref.id === evidence.id)) entry.evidence.push(evidence);
    } else {
      files.set(key, { path: key, resolvedPath, evidence: [evidence] });
      if (!resolvedPath && candidates.length === 0)
        unresolved(`Unresolved evidence path: ${path}`, [evidence]);
    }
  };
  try {
    const assessment = await readKnowledgeIndexAssessment(projectRoot);
    if (assessment) result.sourceRoot = resolve(assessment.sourceRoot);
    sourceRoots = [result.sourceRoot];
    for (const included of assessment?.includedRepositories ?? []) {
      const root = resolve(result.sourceRoot, included);
      const scoped = relative(result.sourceRoot, root);
      if (scoped.startsWith('..') || isAbsolute(scoped)) {
        unresolved(`Configured evidence repository is outside the source root: ${included}`, []);
      } else if (!sourceRoots.includes(root)) sourceRoots.push(root);
    }
    const accessor = await getTaskAccessor(projectRoot);
    const task = await accessor.loadSingleTask(taskId);
    if (!task) unresolved(`Task ${taskId} is not available in this project.`, []);
    for (const path of task?.files ?? []) addFile(path, reference(`${taskId}:files`, 'task'));
    const commits = new Map<string, KnowledgeEvidenceRef>();
    for (const [gate, evidence] of Object.entries(task?.verification?.evidence ?? {})) {
      for (const atom of evidence.atoms) {
        const id = `${taskId}:verification:${gate}`;
        if (atom.kind === 'files') {
          for (const file of atom.files) addFile(file.path, reference(id, 'verification'));
        } else if (atom.kind === 'commit') {
          commits.set(atom.sha, reference(atom.sha, 'commit', atom.sha));
        } else if (atom.kind === 'test-run') {
          coverage.evidence.push({ ...reference(id, 'verification'), precision: 'record' });
        }
      }
    }
    if (commits.size > 20)
      unresolved('Commit expansion is limited to 20 explicit references.', [...commits.values()]);
    commitExpansion: for (const [sha, evidence] of [...commits].slice(0, 20)) {
      if (!/^[a-f0-9]{7,64}$/i.test(sha)) {
        unresolved(`Unsupported commit reference: ${sha}`, [evidence]);
        continue;
      }
      const matches: Array<{ root: string; paths: string[] }> = [];
      for (const repositoryRoot of sourceRoots) {
        if (remaining() === 0) {
          defer();
          break commitExpansion;
        }
        try {
          const { stdout: topLevel } = await execFileAsync(
            'git',
            ['rev-parse', '--show-toplevel'],
            {
              cwd: repositoryRoot,
              timeout: Math.max(1, Math.min(1000, remaining())),
              maxBuffer: 1024 * 1024,
            },
          );
          // A directory inside its parent's checkout is not another repository scope.
          if (resolve(topLevel.trim()) !== resolve(repositoryRoot)) continue;
          if (remaining() === 0) {
            defer();
            break commitExpansion;
          }
          const { stdout } = await execFileAsync(
            'git',
            ['diff-tree', '--no-commit-id', '--root', '-r', '--name-only', '-z', sha, '--'],
            {
              cwd: repositoryRoot,
              timeout: Math.max(1, Math.min(1000, remaining())),
              maxBuffer: 1024 * 1024,
            },
          );
          matches.push({ root: repositoryRoot, paths: stdout.split('\0').filter(Boolean) });
        } catch {
          if (remaining() === 0) {
            defer();
            break commitExpansion;
          }
          /* An explicitly included repository may not contain this commit. */
        }
      }
      if (matches.length === 1) {
        const match = matches[0];
        for (const path of match.paths)
          addFile(relative(result.sourceRoot, resolve(match.root, path)), evidence);
      } else {
        unresolved(
          matches.length > 1
            ? `Commit ${sha} is ambiguous across explicitly included repositories: ${matches.map((match) => relative(result.sourceRoot, match.root) || '.').join(', ')}`
            : `Commit cannot be resolved in the configured source roots: ${sha}`,
          [evidence],
        );
      }
    }

    if (remaining() === 0) defer();
    const attachments =
      remaining() === 0
        ? []
        : await createAttachmentStore().listByOwner('task', taskId, projectRoot);
    for (const metadata of attachments) {
      if (remaining() === 0) {
        defer();
        break;
      }
      const evidence = reference(metadata.id, 'attachment');
      if (metadata.attachment.kind === 'local-file') addFile(metadata.attachment.path, evidence);
      else
        unresolved(
          `Attachment ${metadata.id} requires explicit code-path interpretation (${metadata.attachment.kind}).`,
          [evidence],
        );
    }
  } catch (error) {
    recordKnowledgeGap(
      coverage,
      'failed',
      `Task evidence discovery failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  result.files = [...files.values()];
  coverage.evidence.push(...result.files.flatMap((file) => file.evidence));
  return result;
}
