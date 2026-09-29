/**
 * Component PRs landed by an integration PR (T12671, T12672).
 *
 * A task's own PR (the COMPONENT) often merges into an integration branch,
 * whose PR (the INTEGRATION PR) then lands on the default branch. The
 * integration PR carries the merge commit on the default branch and the CI
 * that ran; the component PR carries the task linkage and the task's change.
 * `pr:<component>@<integration>` and `ci:<component>@<integration>` record
 * both, and this module is the one place that verifies the relationship and
 * derives the component's files:
 *
 *  - the component PR merged into the integration PR's head branch;
 *  - its merge commit is an ancestor of the integration PR's final head, so
 *    the integration PR carried it;
 *  - its files are the ones its merge commit changed that still exist in the
 *    integration PR's merge commit — never the whole integration diff.
 *
 * @task T12671
 * @task T12672
 */

import { execFileSync } from 'node:child_process';

/** One component PR as `gh pr view` reports it. */
export interface ComponentPrView {
  /** PR number. */
  number: number;
  /** PR title. */
  title: string;
  /** PR body. */
  body: string;
  /** Head branch. */
  headRefName: string;
  /** Branch it merged into. */
  baseRefName: string;
  /** `MERGED`, `OPEN` or `CLOSED`. */
  state: string;
  /** Merge commit, or null when unmerged. */
  mergeCommitSha: string | null;
}

/** Reads one PR; null when `gh` cannot. */
export type ViewComponentPr = (prNumber: number, root: string) => Promise<ComponentPrView | null>;

/** The integration PR that landed the component on the default branch. */
export interface LandingPr {
  /** Integration PR number. */
  prNumber: number;
  /** Its head (integration) branch. */
  headRefName: string;
  /** Its final head commit, when known. */
  headRefOid: string | null | undefined;
  /** Its merge commit on the default branch. */
  mergeCommitSha: string;
}

/** A verified component PR, or why it is not one. */
export type ComponentPrResolution =
  | {
      ok: true;
      /** Component PR number. */
      prNumber: number;
      /** Title, body and head branch: the task-linkage assertions. */
      title: string;
      body: string;
      headRefName: string;
      /** Files the component changed that survive in the integration merge. */
      files: string[];
      /** Files the component deleted. */
      deleted: string[];
    }
  | {
      ok: false;
      reason: string;
      codeName:
        | 'E_EVIDENCE_INSUFFICIENT'
        | 'E_EVIDENCE_CONTENT_MISMATCH'
        | 'E_EVIDENCE_TOOL_FAILED';
    };

function git(root: string, args: readonly string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function hasCommit(root: string, sha: string | null | undefined): sha is string {
  return (
    typeof sha === 'string' &&
    sha !== '' &&
    git(root, ['cat-file', '-e', `${sha}^{commit}`]) !== null
  );
}

/** Default {@link ViewComponentPr}: `gh pr view <n>`. */
export const defaultViewComponentPr: ViewComponentPr = async (prNumber, root) => {
  let row: Record<string, unknown>;
  try {
    row = JSON.parse(
      execFileSync(
        'gh',
        [
          'pr',
          'view',
          String(prNumber),
          '--json',
          'number,title,body,headRefName,baseRefName,state,mergeCommit',
        ],
        { cwd: root, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
      ),
    ) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof row.number !== 'number') return null;
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const merge = row.mergeCommit as { oid?: unknown } | null | undefined;
  return {
    number: row.number,
    title: str(row.title),
    body: str(row.body),
    headRefName: str(row.headRefName),
    baseRefName: str(row.baseRefName),
    state: str(row.state),
    mergeCommitSha: typeof merge?.oid === 'string' ? merge.oid : null,
  };
};

/**
 * The component's change as it landed: first-parent name-status of its merge
 * (or squash) commit, keeping only the files that still exist in the landing
 * merge commit.
 *
 * @param root - Git checkout holding both commits.
 * @param componentMerge - The component PR's merge commit.
 * @param landingMerge - The integration PR's merge commit.
 * @returns Surviving changed files and the component's deletions.
 * @task T12672
 */
export function componentLandedChanges(
  root: string,
  componentMerge: string,
  landingMerge: string,
): { files: string[]; deleted: string[] } {
  const out =
    git(root, [
      'diff-tree',
      '--root',
      '--no-commit-id',
      '-r',
      '--name-status',
      '--no-renames',
      '-m',
      '--first-parent',
      componentMerge,
    ]) ?? '';
  const files: string[] = [];
  const deleted: string[] = [];
  for (const line of out.split('\n')) {
    const [status, ...rest] = line.split('\t');
    const path = rest.join('\t');
    if (!status || !path) continue;
    if (status.startsWith('D')) deleted.push(path);
    else if (git(root, ['cat-file', '-e', `${landingMerge}:${path}`]) !== null) files.push(path);
  }
  return { files: [...new Set(files)], deleted: [...new Set(deleted)] };
}

/**
 * Verify that `componentPrNumber` is a component the integration PR landed,
 * and derive its landed files.
 *
 * @param componentPrNumber - The task's own (component) PR.
 * @param landing - The integration PR that reached the default branch.
 * @param root - Git checkout (the execution root).
 * @param view - PR reader (tests inject).
 * @returns The component's linkage fields and files, or the refusal.
 * @task T12671
 */
export async function resolveComponentPr(
  componentPrNumber: number,
  landing: LandingPr,
  root: string,
  view: ViewComponentPr = defaultViewComponentPr,
): Promise<ComponentPrResolution> {
  const c = await view(componentPrNumber, root);
  if (!c) {
    return {
      ok: false,
      codeName: 'E_EVIDENCE_TOOL_FAILED',
      reason: `gh pr view ${componentPrNumber} failed; component PR #${componentPrNumber} cannot be verified.`,
    };
  }
  if (c.state !== 'MERGED') {
    return {
      ok: false,
      codeName: 'E_EVIDENCE_INSUFFICIENT',
      reason: `Component PR #${componentPrNumber} is ${c.state.toLowerCase() || 'not merged'}.`,
    };
  }
  if (c.baseRefName !== landing.headRefName) {
    return {
      ok: false,
      codeName: 'E_EVIDENCE_CONTENT_MISMATCH',
      reason: `Component PR #${componentPrNumber} merged into ${c.baseRefName || 'an unknown branch'}, not ${landing.headRefName}, the head of PR #${landing.prNumber}.`,
    };
  }
  if (!hasCommit(root, c.mergeCommitSha) || !hasCommit(root, landing.headRefOid)) {
    return {
      ok: false,
      codeName: 'E_EVIDENCE_INSUFFICIENT',
      reason: `PR #${componentPrNumber}'s merge commit or PR #${landing.prNumber}'s head is not available locally in ${root} (git fetch origin).`,
    };
  }
  if (git(root, ['merge-base', '--is-ancestor', c.mergeCommitSha, landing.headRefOid]) === null) {
    return {
      ok: false,
      codeName: 'E_EVIDENCE_CONTENT_MISMATCH',
      reason: `PR #${landing.prNumber}'s head does not contain component PR #${componentPrNumber}'s merge ${c.mergeCommitSha.slice(0, 12)}.`,
    };
  }
  const { files, deleted } = componentLandedChanges(root, c.mergeCommitSha, landing.mergeCommitSha);
  if (files.length === 0 && deleted.length === 0) {
    return {
      ok: false,
      codeName: 'E_EVIDENCE_CONTENT_MISMATCH',
      reason: `None of component PR #${componentPrNumber}'s changes survive in PR #${landing.prNumber}'s merge commit.`,
    };
  }
  return {
    ok: true,
    prNumber: componentPrNumber,
    title: c.title,
    body: c.body,
    headRefName: c.headRefName,
    files,
    deleted,
  };
}
