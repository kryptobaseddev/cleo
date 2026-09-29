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
 * A component that did not merge into the integration branch as a PR — closed
 * by hand after a `git merge --no-ff`, marked merged by GitHub, stacked on
 * another component, main-merged afterwards, or rebased into the batch — is
 * verified commit by commit instead (T12710): every commit of its own is in
 * the integration merge by ancestry, or by `git patch-id` when rebased, and
 * {@link findComponentLanding} follows it to that integration PR.
 *
 * @task T12671
 * @task T12672
 * @task T12710
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ghQueryTimeoutMs, ghTimeoutReason, isGhTimeout } from '../release/github-pr.js';

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
  /** Head branch tip the PR carried, when known (T12710). */
  headRefOid?: string | null;
  /** The PR's commits, oldest first, when known (T12710). */
  commits?: string[];
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

/** Output ceiling for git reads: an integration range's `log -p` is large. */
const GIT_MAX_BUFFER = 256 * 1024 * 1024;

function git(root: string, args: readonly string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: GIT_MAX_BUFFER,
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
          'number,title,body,headRefName,baseRefName,state,mergeCommit,headRefOid,commits',
        ],
        {
          cwd: root,
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: ghQueryTimeoutMs(),
        },
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
    headRefOid: typeof row.headRefOid === 'string' ? row.headRefOid : null,
    commits: commitOids(row.commits),
  };
};

/** `commits[].oid` of a `gh --json commits` row, oldest first. */
function commitOids(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const c of raw) {
    const oid = (c as { oid?: unknown } | null)?.oid;
    if (typeof oid === 'string' && oid !== '') out.push(oid);
  }
  return out;
}

/**
 * The component's change as it landed: first-parent name-status of its merge
 * (or squash) commit, keeping only the changes the landing merge commit still
 * carries (T12671 review HIGH) — a changed file whose blob in the landing
 * commit equals the component's resulting blob, and a deletion whose path is
 * absent from the landing commit. A path that merely exists is not enough: a
 * component reverted on the integration branch lands its paths unchanged.
 *
 * Limitation: a REBASE-merged component's `mergeCommit` is only the last
 * rebased commit, so earlier commits' files are not seen. That under-reports
 * the change and fails closed (fewer surviving files, possibly a refusal);
 * GitHub does not report the merge method needed to diff the whole range.
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
  return survivingChanges(root, out, `${componentMerge}^1`, componentMerge, landingMerge);
}

/**
 * Keep the changes of a `from`..`tip` name-status listing that the landing
 * commit still carries: a changed path whose landing blob equals `tip`'s, or
 * whose `from`..`tip` hunks reverse-apply there and do not re-apply (T12689);
 * a deletion whose path the landing commit lacks.
 */
function survivingChanges(
  root: string,
  nameStatus: string,
  from: string,
  tip: string,
  landingMerge: string,
): { files: string[]; deleted: string[] } {
  const files: string[] = [];
  const deleted: string[] = [];
  const blob = (commit: string, path: string): string | null =>
    git(root, ['rev-parse', '--verify', '--quiet', `${commit}:${path}`]);
  const stillApplies = hunkChecker(root, from, tip, landingMerge);
  try {
    for (const line of nameStatus.split('\n')) {
      const [status, ...rest] = line.split('\t');
      const path = rest.join('\t');
      if (!status || !path) continue;
      if (status.startsWith('D')) {
        if (blob(landingMerge, path) === null) deleted.push(path);
        continue;
      }
      const own = blob(tip, path);
      const landed = blob(landingMerge, path);
      // Identical bytes, or (T12689) a file a later change also edited whose
      // own hunks the landing version still carries.
      if (own !== null && landed !== null && (own === landed || stillApplies(path)))
        files.push(path);
    }
  } finally {
    stillApplies.dispose();
  }
  return { files: [...new Set(files)], deleted: [...new Set(deleted)] };
}

/**
 * Whether the component's hunks for one path are still present in the
 * landing commit: its first-parent patch reverse-applies cleanly to the
 * landing tree (checked in a throwaway index, never the working tree). A
 * revert fails this; a later edit elsewhere in the file does not (T12689).
 */
function hunkChecker(
  root: string,
  from: string,
  tip: string,
  landingMerge: string,
): ((path: string) => boolean) & { dispose: () => void } {
  let dir: string | null = null;
  let env: NodeJS.ProcessEnv | null = null;
  let failed = false;
  const ready = (): NodeJS.ProcessEnv | null => {
    if (env || failed) return env;
    dir = mkdtempSync(join(tmpdir(), 'cleo-component-index-'));
    const candidate = { ...process.env, GIT_INDEX_FILE: join(dir, 'index') };
    try {
      execFileSync('git', ['read-tree', landingMerge], {
        cwd: root,
        env: candidate,
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      env = candidate;
    } catch {
      // No index, no credit — and no retry leaving another temp dir behind.
      failed = true;
      rmSync(dir, { recursive: true, force: true });
      dir = null;
    }
    return env;
  };
  const applies = (patch: string, indexEnv: NodeJS.ProcessEnv, reverse: boolean): boolean => {
    try {
      execFileSync('git', ['apply', '--cached', '--check', ...(reverse ? ['-R'] : [])], {
        cwd: root,
        env: indexEnv,
        input: `${patch}\n`,
        stdio: ['pipe', 'ignore', 'ignore'],
      });
      return true;
    } catch {
      return false;
    }
  };
  const check = (path: string): boolean => {
    const patch = git(root, [
      'diff',
      '--binary',
      '--no-renames',
      '--no-color',
      from,
      tip,
      '--',
      path,
    ]);
    const indexEnv = patch ? ready() : null;
    if (!patch || !indexEnv) return false;
    // `git apply` finds a hunk at ANY offset (T12689 review MED): the reverse
    // patch can match an identical block elsewhere while the component's own
    // lines were reverted. So the change must also NOT be re-applicable — a
    // reverted change is, at its original spot. When both could match the
    // file is not credited (fails closed).
    return applies(patch, indexEnv, true) && !applies(patch, indexEnv, false);
  };
  return Object.assign(check, {
    dispose: () => {
      if (dir) rmSync(dir, { recursive: true, force: true });
    },
  });
}

/** A refusal in the shape every component check returns. */
type Refusal = Extract<ComponentPrResolution, { ok: false }>;

function refuse(codeName: Refusal['codeName'], reason: string): Refusal {
  return { ok: false, codeName, reason };
}

function isAncestor(root: string, ancestor: string, descendant: string): boolean {
  return git(root, ['merge-base', '--is-ancestor', ancestor, descendant]) !== null;
}

/** Parent count of a commit (0 for a root commit); -1 when unreadable. */
function parentCount(root: string, sha: string): number {
  const line = git(root, ['rev-list', '--parents', '-n', '1', sha]);
  return line === null ? -1 : line.split(' ').length - 1;
}

/** The PR's commits (oldest first), else its head; empty when neither is known. */
function componentCommits(c: ComponentPrView): string[] {
  if (c.commits && c.commits.length > 0) return c.commits;
  return c.headRefOid ? [c.headRefOid] : [];
}

/**
 * `git patch-id --stable` of every non-merge commit `git log -p <args>`
 * prints, keyed by patch id. A patch id survives a rebase that does not
 * change the diff, which is how a rebased batch is mapped back (T12710).
 */
function patchIds(root: string, logArgs: readonly string[]): Map<string, string> {
  const ids = new Map<string, string>();
  const patch = git(root, ['log', '-p', '--no-color', '--no-merges', ...logArgs]);
  if (!patch) return ids;
  let out = '';
  try {
    out = execFileSync('git', ['patch-id', '--stable'], {
      cwd: root,
      input: `${patch}\n`,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
      maxBuffer: GIT_MAX_BUFFER,
    });
  } catch {
    return ids;
  }
  for (const line of out.split('\n')) {
    const [id, commit] = line.trim().split(/\s+/);
    if (id && commit && !ids.has(id)) ids.set(id, commit);
  }
  return ids;
}

/** Paths a commit changed against its first parent. */
function commitPaths(root: string, sha: string): string[] {
  const out = git(root, [
    'diff-tree',
    '--root',
    '--no-commit-id',
    '-r',
    '--name-only',
    '--no-renames',
    '-m',
    '--first-parent',
    sha,
  ]);
  return out ? out.split('\n').filter(Boolean) : [];
}

/** The integration PR's side of a commit-level check. */
export type LandingMerge = Pick<LandingPr, 'prNumber' | 'mergeCommitSha'>;

/** A component's change verified commit by commit against one landing merge. */
export type ComponentCommitsLanded =
  | {
      ok: true;
      /** Newest component commit the landing carries (the original tip when rebased). */
      tip: string;
      /** Files the component changed that survive in the landing merge. */
      files: string[];
      /** Files the component deleted that the landing merge lacks. */
      deleted: string[];
    }
  | Refusal;

/**
 * Verify, commit by commit, that a landing merge carries a component PR's
 * change, whatever happened to the PR itself (T12710): closed by hand, marked
 * merged by GitHub, stacked on another component, main merged into its head
 * afterwards, or rebased into the batch.
 *
 * - Every non-merge commit of the PR is an ancestor of the landing merge, or
 *   — when the batch was rebased — has the same `git patch-id` as a commit
 *   the landing merge introduced (`<merge>^1..<merge>`). Git is the proof;
 *   no PR body is consulted.
 * - At least one of them is new in the landing merge (not already on its
 *   first parent), so the landing PR is the one that landed it.
 * - The credited files are only the paths the PR's own commits changed, and
 *   only where the landing merge still carries the change (blob identical,
 *   or the component's hunks reverse-apply and do not re-apply — T12689).
 *
 * @param root - Git checkout holding every commit.
 * @param c - The component PR, with its commit list.
 * @param landing - The integration PR number and its merge commit.
 * @returns The component's tip and surviving changes, or the refusal.
 * @task T12710
 */
export function componentCommitsLanded(
  root: string,
  c: ComponentPrView,
  landing: LandingMerge,
): ComponentCommitsLanded {
  const n = c.number;
  const i = landing.prNumber;
  const m = landing.mergeCommitSha;
  const commits = componentCommits(c);
  if (commits.length === 0) {
    return refuse('E_EVIDENCE_INSUFFICIENT', `gh reports no commits for component PR #${n}.`);
  }
  const missing = commits.find((sha): boolean => !hasCommit(root, sha));
  if (missing || !hasCommit(root, m)) {
    return refuse(
      'E_EVIDENCE_INSUFFICIENT',
      `${missing ? `Component PR #${n}'s commit ${missing.slice(0, 12)}` : `PR #${i}'s merge commit ${m.slice(0, 12)}`} is not available locally in ${root} (git fetch origin pull/${n}/head).`,
    );
  }
  const firstParent = git(root, ['rev-parse', '--verify', '--quiet', `${m}^1`]);
  if (!firstParent) {
    return refuse('E_EVIDENCE_CONTENT_MISMATCH', `PR #${i}'s merge commit has no parent.`);
  }
  const own = commits.filter((sha) => {
    const parents = parentCount(root, sha);
    return parents === 0 || parents === 1;
  });
  if (own.length === 0) {
    return refuse(
      'E_EVIDENCE_CONTENT_MISMATCH',
      `Component PR #${n} has no commits of its own, only merges.`,
    );
  }
  let introduced: Map<string, string> | null = null;
  let landedNow = false;
  for (const sha of own) {
    if (isAncestor(root, sha, m)) {
      if (!isAncestor(root, sha, firstParent)) landedNow = true;
      continue;
    }
    introduced ??= patchIds(root, [`${firstParent}..${m}`]);
    const [id] = patchIds(root, ['--no-walk', sha]).keys();
    if (id !== undefined && introduced.has(id)) {
      landedNow = true;
      continue;
    }
    return refuse(
      'E_EVIDENCE_CONTENT_MISMATCH',
      `Commit ${sha.slice(0, 12)} of component PR #${n} is not in PR #${i}'s merge ${m.slice(0, 12)}, by ancestry or by patch-id.`,
    );
  }
  if (!landedNow) {
    return refuse(
      'E_EVIDENCE_CONTENT_MISMATCH',
      `Component PR #${n}'s commits were already on the default branch before PR #${i}; PR #${i} did not land them.`,
    );
  }
  const tip = [...commits].reverse().find((sha) => isAncestor(root, sha, m)) ?? own.at(-1);
  const from = tip ? git(root, ['merge-base', tip, firstParent]) : null;
  if (!tip || !from) {
    return refuse(
      'E_EVIDENCE_CONTENT_MISMATCH',
      `Component PR #${n} shares no history with PR #${i}'s base.`,
    );
  }
  // Only the paths the PR's own commits changed: a stacked component's diff
  // from the fork point also holds the component below it.
  const paths = [...new Set(own.flatMap((sha) => commitPaths(root, sha)))];
  const nameStatus =
    paths.length === 0
      ? ''
      : (git(root, ['diff', '--name-status', '--no-renames', from, tip, '--', ...paths]) ?? '');
  return { ok: true, tip, ...survivingChanges(root, nameStatus, from, tip, m) };
}

/**
 * The first commit on `ref`'s first-parent chain that contains `sha`: the
 * commit that landed it on the default branch. `sha` itself when it is on
 * that chain; null when `ref` does not contain it.
 *
 * @param root - Git checkout.
 * @param sha - A commit.
 * @param ref - The default branch ref, e.g. `origin/main`.
 * @returns The landing commit, or null.
 * @task T12710
 */
export function landingCommitOn(root: string, sha: string, ref: string): string | null {
  if (!isAncestor(root, sha, ref)) return null;
  const chain = git(root, ['rev-list', '--first-parent', `${sha}..${ref}`]);
  if (!chain) return sha;
  const descendants = new Set(
    (git(root, ['rev-list', '--ancestry-path', `${sha}..${ref}`]) ?? '').split('\n'),
  );
  const oldest = chain
    .split('\n')
    .reverse()
    .find((c) => descendants.has(c));
  if (!oldest) return null;
  return git(root, ['rev-parse', `${oldest}^1`]) === sha ? sha : oldest;
}

/** A merged PR that may have landed a component (a candidate integration PR). */
export interface LandingCandidate {
  /** PR number. */
  number: number;
  /** Head (integration) branch. */
  headRefName: string;
  /** Branch it merged into. */
  baseRefName: string;
  /** `MERGED`, `OPEN` or `CLOSED`. */
  state: string;
  /** Final head commit, when known. */
  headRefOid: string | null;
  /** Merge commit on the base branch, or null. */
  mergeCommitSha: string | null;
  /** PR body (a hint only, never proof). */
  body: string;
}

/** A bounded `gh` PR search: the PRs, or why it failed (offline, timeout). */
export type LandingSearch = { ok: true; prs: LandingCandidate[] } | { ok: false; reason: string };

/** `gh` lookups {@link findComponentLanding} needs (tests inject). */
export interface ComponentLandingDeps {
  /** Merged PRs whose merge commit may be `sha`. */
  prsByMergeCommit?: (sha: string, root: string) => Promise<LandingSearch>;
  /** Merged PRs whose body may list `#<componentPrNumber>` — a hint for rebased batches. */
  prsListingComponent?: (componentPrNumber: number, root: string) => Promise<LandingSearch>;
}

const LANDING_FIELDS = 'number,headRefName,baseRefName,state,headRefOid,mergeCommit,body';

/** `gh pr list --state merged --search <q>`, bounded by the evidence gh deadline. */
function searchMergedPrs(search: string, root: string): LandingSearch {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      execFileSync(
        'gh',
        [
          'pr',
          'list',
          '--state',
          'merged',
          '--search',
          search,
          '--json',
          LANDING_FIELDS,
          '--limit',
          '20',
        ],
        {
          cwd: root,
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: ghQueryTimeoutMs(),
        },
      ),
    );
  } catch (err) {
    const what = `gh pr list --search '${search}'`;
    return {
      ok: false,
      reason: isGhTimeout(err)
        ? ghTimeoutReason(what)
        : `${what} failed (offline, or gh not authenticated): ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`,
    };
  }
  if (!Array.isArray(parsed)) return { ok: true, prs: [] };
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const prs: LandingCandidate[] = [];
  for (const raw of parsed) {
    if (raw === null || typeof raw !== 'object') continue;
    const row = raw as Record<string, unknown>;
    if (typeof row.number !== 'number') continue;
    const merge = row.mergeCommit as { oid?: unknown } | null | undefined;
    prs.push({
      number: row.number,
      headRefName: str(row.headRefName),
      baseRefName: str(row.baseRefName),
      state: str(row.state),
      headRefOid: typeof row.headRefOid === 'string' ? row.headRefOid : null,
      mergeCommitSha: typeof merge?.oid === 'string' ? merge.oid : null,
      body: str(row.body),
    });
  }
  return { ok: true, prs };
}

/** Default {@link ComponentLandingDeps}: bounded `gh pr list` searches. */
export const defaultComponentLandingDeps: Required<ComponentLandingDeps> = {
  prsByMergeCommit: async (sha, root) => searchMergedPrs(sha, root),
  prsListingComponent: async (n, root) => searchMergedPrs(`${n} in:body`, root),
};

/** Whether a PR body lists `#<n>` (never `#<n>0`). */
function listsPr(body: string, n: number): boolean {
  return new RegExp(`#${n}(?![0-9])`).test(body);
}

/** The integration PR that landed a component, with the component's surviving changes. */
export type ComponentLanding =
  | {
      ok: true;
      /** The integration PR (merged into the default branch). */
      landing: LandingCandidate & { mergeCommitSha: string };
      /** Files the component changed that survive in the landing merge. */
      files: string[];
      /** Files the component deleted that the landing merge lacks. */
      deleted: string[];
    }
  | Refusal;

/**
 * Follow a component PR to the PR that landed it on the default branch
 * (T12671, T12710). Resolution, git first:
 *
 * 1. Ancestry: the newest PR commit the default branch contains is landed by
 *    the first commit on the default branch's first-parent chain containing
 *    it; the merged PR whose merge commit that is, is the landing PR. When
 *    that commit is the component's own merge, it landed directly: `null`.
 * 2. Rebased batch (no PR commit is on the default branch): merged PRs into
 *    the default branch whose body lists `#<component>` are candidates — a
 *    hint only — and each is accepted only through patch-id proof.
 *
 * Either way {@link componentCommitsLanded} is the proof: every commit of the
 * component is in the landing merge, and only its surviving files are
 * credited. A `gh` failure (offline, timeout) is a refusal, never a hang.
 *
 * @param root - Git checkout with the default branch fetched.
 * @param c - The component PR (with its commits).
 * @param defaultRef - The default branch ref, e.g. `origin/main`.
 * @param deps - `gh` lookups (tests inject).
 * @returns The landing PR and surviving changes, a refusal, or `null` when the
 *   PR landed directly (its own merge is on the default branch).
 * @task T12710
 */
export async function findComponentLanding(
  root: string,
  c: ComponentPrView,
  defaultRef: string,
  deps: ComponentLandingDeps = {},
): Promise<ComponentLanding | null> {
  const n = c.number;
  if (c.state === 'OPEN') {
    return refuse('E_EVIDENCE_INSUFFICIENT', `Component PR #${n} is open.`);
  }
  const commits = componentCommits(c);
  if (commits.length === 0) {
    return refuse('E_EVIDENCE_INSUFFICIENT', `gh reports no commits for PR #${n}.`);
  }
  const missing = commits.find((sha): boolean => !hasCommit(root, sha));
  if (missing) {
    return refuse(
      'E_EVIDENCE_INSUFFICIENT',
      `PR #${n}'s commit ${missing.slice(0, 12)} is not available locally in ${root} (git fetch origin pull/${n}/head).`,
    );
  }
  const defaultBranch = defaultRef.replace(/^origin\//, '');
  const lookups = { ...defaultComponentLandingDeps, ...deps };
  const onDefault = [...commits].reverse().find((sha) => isAncestor(root, sha, defaultRef));
  let candidates: LandingCandidate[];
  if (onDefault) {
    const m = landingCommitOn(root, onDefault, defaultRef);
    if (m === null || m === c.mergeCommitSha) return null;
    const found = await lookups.prsByMergeCommit(m, root);
    if (!found.ok) return refuse('E_EVIDENCE_TOOL_FAILED', found.reason);
    const merged = found.prs.filter(
      (p) => p.state === 'MERGED' && p.mergeCommitSha === m && p.baseRefName === defaultBranch,
    );
    if (merged.some((p) => p.number === n)) return null;
    candidates = merged;
    if (candidates.length === 0) {
      return refuse(
        'E_EVIDENCE_INSUFFICIENT',
        `No merged PR into ${defaultBranch} has ${m.slice(0, 12)}, the commit that landed PR #${n}'s commits, as its merge commit.`,
      );
    }
  } else {
    const found = await lookups.prsListingComponent(n, root);
    if (!found.ok) return refuse('E_EVIDENCE_TOOL_FAILED', found.reason);
    candidates = found.prs
      .filter(
        (p) =>
          p.number !== n &&
          p.state === 'MERGED' &&
          p.baseRefName === defaultBranch &&
          listsPr(p.body, n) &&
          hasCommit(root, p.mergeCommitSha) &&
          isAncestor(root, p.mergeCommitSha, defaultRef),
      )
      .sort((a, b) => b.number - a.number);
    if (candidates.length === 0) {
      return refuse(
        'E_EVIDENCE_INSUFFICIENT',
        `PR #${n}'s commits are not on ${defaultBranch}, and no merged PR into ${defaultBranch} lists #${n}.`,
      );
    }
  }
  const reasons: string[] = [];
  for (const candidate of candidates) {
    const mergeCommitSha = candidate.mergeCommitSha as string;
    const r = componentCommitsLanded(root, c, { prNumber: candidate.number, mergeCommitSha });
    if (r.ok && (r.files.length > 0 || r.deleted.length > 0)) {
      return {
        ok: true,
        landing: { ...candidate, mergeCommitSha },
        files: r.files,
        deleted: r.deleted,
      };
    }
    reasons.push(
      r.ok
        ? `None of component PR #${n}'s changes survive in PR #${candidate.number}'s merge commit.`
        : r.reason,
    );
  }
  return refuse('E_EVIDENCE_CONTENT_MISMATCH', reasons.join(' '));
}

/**
 * The original T12671 proof: the component PR merged into the integration
 * PR's head branch, and that head contains its merge commit. Null when it
 * holds; the refusal otherwise.
 */
function mergedIntoIntegration(
  c: ComponentPrView,
  landing: LandingPr,
  root: string,
): Refusal | null {
  const n = c.number;
  if (c.state !== 'MERGED') {
    return refuse(
      'E_EVIDENCE_INSUFFICIENT',
      `Component PR #${n} is ${c.state.toLowerCase() || 'not merged'}.`,
    );
  }
  if (c.baseRefName !== landing.headRefName) {
    return refuse(
      'E_EVIDENCE_CONTENT_MISMATCH',
      `Component PR #${n} merged into ${c.baseRefName || 'an unknown branch'}, not ${landing.headRefName}, the head of PR #${landing.prNumber}.`,
    );
  }
  if (!hasCommit(root, c.mergeCommitSha) || !hasCommit(root, landing.headRefOid)) {
    return refuse(
      'E_EVIDENCE_INSUFFICIENT',
      `PR #${n}'s merge commit or PR #${landing.prNumber}'s head is not available locally in ${root} (git fetch origin).`,
    );
  }
  if (!isAncestor(root, c.mergeCommitSha, landing.headRefOid)) {
    return refuse(
      'E_EVIDENCE_CONTENT_MISMATCH',
      `PR #${landing.prNumber}'s head does not contain component PR #${n}'s merge ${c.mergeCommitSha.slice(0, 12)}.`,
    );
  }
  return null;
}

/**
 * Verify that `componentPrNumber` is a component the integration PR landed,
 * and derive its landed files. Two proofs, first match wins:
 *
 * - the component PR merged into the integration PR's head branch, whose
 *   head contains its merge commit (T12671);
 * - otherwise every commit of its own is in the integration merge, by
 *   ancestry or patch-id ({@link componentCommitsLanded}, T12710) — a
 *   component closed by hand, marked merged by GitHub, stacked, main-merged
 *   afterwards, or rebased into the batch.
 *
 * @param componentPrNumber - The task's own (component) PR.
 * @param landing - The integration PR that reached the default branch.
 * @param root - Git checkout (the execution root).
 * @param view - PR reader (tests inject).
 * @returns The component's linkage fields and files, or the refusal.
 * @task T12671
 * @task T12710
 */
export async function resolveComponentPr(
  componentPrNumber: number,
  landing: LandingPr,
  root: string,
  view: ViewComponentPr = defaultViewComponentPr,
): Promise<ComponentPrResolution> {
  const c = await view(componentPrNumber, root);
  if (!c) {
    return refuse(
      'E_EVIDENCE_TOOL_FAILED',
      `gh pr view ${componentPrNumber} failed; component PR #${componentPrNumber} cannot be verified.`,
    );
  }
  if (c.state === 'OPEN') {
    return refuse('E_EVIDENCE_INSUFFICIENT', `Component PR #${componentPrNumber} is open.`);
  }
  let changes: { files: string[]; deleted: string[] };
  const viaMerge = mergedIntoIntegration(c, landing, root);
  if (viaMerge === null) {
    changes = componentLandedChanges(root, c.mergeCommitSha as string, landing.mergeCommitSha);
  } else {
    if (componentCommits(c).length === 0) return viaMerge;
    const viaCommits = componentCommitsLanded(root, c, landing);
    if (!viaCommits.ok) {
      return refuse(viaCommits.codeName, `${viaMerge.reason} ${viaCommits.reason}`);
    }
    changes = viaCommits;
  }
  const { files, deleted } = changes;
  if (files.length === 0 && deleted.length === 0) {
    return refuse(
      'E_EVIDENCE_CONTENT_MISMATCH',
      `None of component PR #${componentPrNumber}'s changes survive in PR #${landing.prNumber}'s merge commit.`,
    );
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
