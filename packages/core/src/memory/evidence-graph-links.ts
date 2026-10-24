/**
 * Graph links from accepted verification evidence (T13950).
 *
 * When `cleo verify` accepts evidence atoms it has already validated them
 * against git, the filesystem or GitHub. Those atoms are the most reliable
 * statement of what a task touched, so they become graph edges:
 *
 * | atom        | graph write                                                    |
 * |-------------|----------------------------------------------------------------|
 * | `commit`    | `task:<id> --touches_code--> commit:<sha>` (`ensureCommitNode`) |
 * | `pr`        | the same, for the PR's merge commit                            |
 * | `files`     | `task:<id> --touches_code--> file:<path>`                      |
 * | `decision`  | `decision:<id> --applies_to--> task:<id>`                      |
 *
 * Other atoms (tool runs, test runs, notes, `satisfies` bindings that already
 * live in the tasks store) add no edge. Writes are explicit (they do not depend
 * on `brain.autoCapture`) and idempotent: nodes are created when absent and an
 * existing edge is left unchanged, so re-verifying adds nothing.
 *
 * Code placed in `packages/core/` per Package-Boundary Check — verified against AGENTS.md.
 *
 * @module memory/evidence-graph-links
 * @task T13950
 */

import type { EvidenceAtom } from '@cleocode/contracts';
import { addGraphEdge, ensureCommitNode, upsertGraphNode } from './graph-auto-populate.js';

/** Provenance stamped on every edge this module writes. */
export const EVIDENCE_EDGE_PROVENANCE = 'evidence:verify';

/** Graph writes from one accepted verification. */
export interface EvidenceLinkResult {
  /** Commits linked (from `commit` and `pr` atoms). */
  commits: number;
  /** Files linked. */
  files: number;
  /** Decisions linked. */
  decisions: number;
}

/**
 * Link a task to the commits, files and decisions its accepted evidence names.
 *
 * @param projectRoot - Project whose brain graph is written.
 * @param taskId - Task the evidence was accepted for.
 * @param atoms - Validated atoms the verification stored.
 * @returns Counts of linked targets (repeat links count again; writes are idempotent).
 * @example
 * ```ts
 * await linkVerifiedEvidence(root, 'T123', evidenceStored);
 * ```
 */
export async function linkVerifiedEvidence(
  projectRoot: string,
  taskId: string,
  atoms: readonly EvidenceAtom[],
): Promise<EvidenceLinkResult> {
  const result: EvidenceLinkResult = { commits: 0, files: 0, decisions: 0 };
  const taskNode = `task:${taskId}`;
  const explicit = { explicit: true, ifAbsent: true };
  await upsertGraphNode(
    projectRoot,
    taskNode,
    'task',
    taskId,
    0.7,
    '',
    undefined,
    undefined,
    explicit,
  );
  const commit = async (sha: string): Promise<void> => {
    await ensureCommitNode(projectRoot, sha, taskId, {
      provenance: EVIDENCE_EDGE_PROVENANCE,
      explicit: true,
    });
    result.commits++;
  };
  for (const atom of atoms) {
    if (atom.kind === 'commit') await commit(atom.sha);
    else if (atom.kind === 'pr') await commit(atom.mergeCommitSha);
    else if (atom.kind === 'files') {
      for (const file of atom.files) {
        const fileNode = `file:${file.path}`;
        await upsertGraphNode(
          projectRoot,
          fileNode,
          'file',
          file.path,
          0.8,
          '',
          undefined,
          undefined,
          explicit,
        );
        await addGraphEdge(
          projectRoot,
          taskNode,
          fileNode,
          'touches_code',
          1,
          EVIDENCE_EDGE_PROVENANCE,
          undefined,
          { explicit: true },
        );
        result.files++;
      }
    } else if (atom.kind === 'decision') {
      const decisionNode = `decision:${atom.decisionId}`;
      await upsertGraphNode(
        projectRoot,
        decisionNode,
        'decision',
        atom.decisionId,
        0.8,
        '',
        undefined,
        undefined,
        explicit,
      );
      await addGraphEdge(
        projectRoot,
        decisionNode,
        taskNode,
        'applies_to',
        1,
        EVIDENCE_EDGE_PROVENANCE,
        undefined,
        { explicit: true },
      );
      result.decisions++;
    }
  }
  return result;
}
