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
 * Node ids are permanent and sync between devices, so a file node is keyed by
 * its POSIX path relative to the checkout that holds it. A path outside both
 * the evidence repository and the store root gets no node and is reported in
 * `skipped`.
 *
 * Code placed in `packages/core/` per Package-Boundary Check — verified against AGENTS.md.
 *
 * @module memory/evidence-graph-links
 * @task T13950
 */

import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { EvidenceAtom } from '@cleocode/contracts';
import { gitToplevel } from '../git/work-tree.js';
import type { BrainEdgeType, BrainNodeType } from '../store/schema/memory-schema.js';
import { resolveEvidenceExecutionRoot } from '../tasks/evidence.js';
import { ensureCommitNode, writeGraphBatch } from './graph-auto-populate.js';

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
  /** `files:` paths given no node because they lie outside the evidence repository. */
  skipped: string[];
}

/**
 * Resolve symlinks (macOS `/tmp` → `/private/tmp`) through the nearest
 * existing ancestor, so a file deleted since verify still compares equal.
 */
function real(path: string): string {
  const abs = resolve(path);
  const parent = dirname(abs);
  if (existsSync(abs) || parent === abs) {
    try {
      return realpathSync(abs);
    } catch {
      return abs;
    }
  }
  return join(real(parent), basename(abs));
}

/** True when `child` is `root` or lies below it. */
function within(root: string, child: string): boolean {
  const rel = relative(real(root), real(child));
  return !(rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel));
}

/** Toplevel of the git checkout holding `abs` (via its nearest existing directory). */
function checkoutOf(abs: string): string | null {
  let dir = dirname(abs);
  while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir);
  return gitToplevel(dir);
}

/**
 * The POSIX path of an evidence file relative to the checkout that holds it,
 * or `null` when it lies outside both the execution and the store root.
 *
 * The file is located as `validateFiles` located it: the execution root when it
 * exists there, else the store root, else (validated at a commit only) the
 * execution root. Keying by the holding checkout makes a file verified from a
 * worktree, from the main checkout, or through a store that parents several
 * repositories (T14005) one node with the commit-anchored form.
 *
 * @param path - Path as the `files:` atom stored it.
 * @param executionRoot - Root of the repository the evidence is about.
 * @param storeRoot - CLEO store root.
 * @returns The normalised path, or `null`.
 * @example
 * ```ts
 * repoRelativeEvidencePath('./src/a.ts', '/repo', '/repo'); // 'src/a.ts'
 * ```
 */
export function repoRelativeEvidencePath(
  path: string,
  executionRoot: string,
  storeRoot: string,
): string | null {
  const fromExecution = isAbsolute(path) ? path : resolve(executionRoot, path);
  const fromStore = resolve(storeRoot, path);
  const abs = existsSync(fromExecution) || !existsSync(fromStore) ? fromExecution : fromStore;
  const insideExecution = within(executionRoot, abs);
  if (!insideExecution && !within(storeRoot, abs)) return null;
  const base = checkoutOf(abs) ?? (insideExecution ? executionRoot : storeRoot);
  const rel = relative(real(base), real(abs));
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return rel.split(sep).join('/');
}

/**
 * Link a task to the commits, files and decisions its accepted evidence names.
 *
 * @param projectRoot - Project whose brain graph is written.
 * @param taskId - Task the evidence was accepted for.
 * @param atoms - Validated atoms the verification stored.
 * @returns Counts of linked targets (repeat links count again; writes are
 *   idempotent) and the paths skipped as outside the repository.
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
  const result: EvidenceLinkResult = { commits: 0, files: 0, decisions: 0, skipped: [] };
  const taskNode = `task:${taskId}`;
  const nodes: Array<{ id: string; nodeType: BrainNodeType; label: string; qualityScore: number }> =
    [{ id: taskNode, nodeType: 'task', label: taskId, qualityScore: 0.7 }];
  const edges: Array<{
    fromId: string;
    toId: string;
    edgeType: BrainEdgeType;
    provenance: string;
  }> = [];
  const shas: string[] = [];
  for (const atom of atoms) {
    if (atom.kind === 'commit') shas.push(atom.sha);
    else if (atom.kind === 'pr') shas.push(atom.mergeCommitSha);
  }
  let executionRoot: string | undefined;
  for (const atom of atoms) {
    if (atom.kind === 'files') {
      // The same anchor validateAtom hands the resolver for a files: atom.
      executionRoot ??= resolveEvidenceExecutionRoot(
        projectRoot,
        undefined,
        shas[0] ? { commitSha: shas[0] } : {},
      );
      for (const file of atom.files) {
        const path = repoRelativeEvidencePath(file.path, executionRoot, projectRoot);
        if (path === null) {
          result.skipped.push(file.path);
          continue;
        }
        nodes.push({ id: `file:${path}`, nodeType: 'file', label: path, qualityScore: 0.8 });
        edges.push({
          fromId: taskNode,
          toId: `file:${path}`,
          edgeType: 'touches_code',
          provenance: EVIDENCE_EDGE_PROVENANCE,
        });
        result.files++;
      }
    } else if (atom.kind === 'decision') {
      const decisionNode = `decision:${atom.decisionId}`;
      nodes.push({
        id: decisionNode,
        nodeType: 'decision',
        label: atom.decisionId,
        qualityScore: 0.8,
      });
      edges.push({
        fromId: decisionNode,
        toId: taskNode,
        edgeType: 'applies_to',
        provenance: EVIDENCE_EDGE_PROVENANCE,
      });
      result.decisions++;
    }
  }
  await writeGraphBatch(projectRoot, nodes, edges);
  const failed: Array<{ sha: string; error: unknown }> = [];
  for (const sha of shas) {
    try {
      await ensureCommitNode(projectRoot, sha, taskId, {
        provenance: EVIDENCE_EDGE_PROVENANCE,
        explicit: true,
      });
      result.commits++;
    } catch (error) {
      failed.push({ sha, error });
    }
  }
  if (failed.length > 0) {
    const first = failed[0]?.error;
    // @sync-invariant none:local-only the verification already committed; the caller warns
    throw new Error(
      `commit links failed for ${failed.map((f) => f.sha.slice(0, 12)).join(', ')}; ` +
        `written: task, ${result.files} file, ${result.decisions} decision and ${result.commits} commit link(s): ` +
        (first instanceof Error ? first.message : String(first)),
    );
  }
  return result;
}
