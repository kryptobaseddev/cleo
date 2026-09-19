/**
 * Read historical task evidence through canonical stores and resolve file-level provenance.
 *
 * Code placed in `packages/core/` per Package-Boundary Check — verified
 * against AGENTS.md. Evidence discovery never rewrites historical verification.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
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
 * @returns Deduplicated file associations, provenance, and unresolved findings.
 * @remarks File evidence never establishes that every symbol in a file changed.
 * @example
 * ```ts
 * const footprint = await getTaskKnowledgeEvidence('T448', projectRoot, undefined);
 * ```
 */
export async function getTaskKnowledgeEvidence(
  taskId: string,
  projectRoot: string,
  existingCoverage?: KnowledgeCoverage,
): Promise<TaskKnowledgeEvidence> {
  const coverage = existingCoverage ?? (await assessKnowledgeCoverage(projectRoot));
  const result: TaskKnowledgeEvidence = {
    taskId,
    sourceRoot: projectRoot,
    files: [],
    coverage,
    findings: [],
  };
  const files = new Map<string, KnowledgeFileEvidence>();
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
    const absolute = resolve(result.sourceRoot, path);
    const sourcePath = relative(result.sourceRoot, absolute);
    const inScope = !sourcePath.startsWith('..') && !isAbsolute(sourcePath);
    const resolvedPath = inScope && existsSync(absolute) ? absolute : null;
    const key = inScope ? sourcePath : path;
    const entry = files.get(key);
    if (entry) {
      if (!entry.evidence.some((ref) => ref.id === evidence.id)) entry.evidence.push(evidence);
    } else {
      files.set(key, { path: key, resolvedPath, evidence: [evidence] });
      if (!resolvedPath) unresolved(`Unresolved evidence path: ${path}`, [evidence]);
    }
  };
  try {
    const assessment = await readKnowledgeIndexAssessment(projectRoot);
    if (assessment) result.sourceRoot = resolve(assessment.sourceRoot);
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
    for (const [sha, evidence] of [...commits].slice(0, 20)) {
      if (!/^[a-f0-9]{7,64}$/i.test(sha)) {
        unresolved(`Unsupported commit reference: ${sha}`, [evidence]);
        continue;
      }
      try {
        const { stdout } = await execFileAsync(
          'git',
          ['diff-tree', '--no-commit-id', '--root', '-r', '--name-only', '-z', sha, '--'],
          {
            cwd: result.sourceRoot,
            timeout: 1000,
            maxBuffer: 1024 * 1024,
          },
        );
        for (const path of stdout.split('\0').filter(Boolean)) addFile(path, evidence);
      } catch {
        unresolved(`Commit cannot be resolved in the configured source root: ${sha}`, [evidence]);
      }
    }
    const attachments = await createAttachmentStore().listByOwner('task', taskId, projectRoot);
    for (const metadata of attachments) {
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
