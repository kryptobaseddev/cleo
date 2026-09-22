/**
 * Whether a recorded commit's work is present in a release tag (T12311).
 *
 * ## Why SHA reachability alone is the wrong question
 *
 * Evidence records `commit:<sha>` at the moment a task is verified, which is
 * while its branch still exists. This repository merges by SQUASH, so that SHA
 * is discarded at merge time and the identical work lands under a new one. A
 * plain `git merge-base --is-ancestor <sha> <tag>` therefore reports the work
 * as absent from every release it actually shipped in.
 *
 * Measured 2026-09-22 shipping v2026.9.12: T12310 was verified on its branch
 * as `8a866465`, merged as `645da636`, and `cleo release reconcile` rejected
 * the release with `commit 8a866465 is not reachable from tag v2026.9.12`.
 * The suggested repair — re-verify the task — is refused by ADR-051 §11.1
 * because the task is already done, so the error named a remedy the system
 * itself forbids and the only way through was an owner override. That is
 * structural: EVERY task verified before its own squash merge lands there.
 *
 * ## What is asked instead
 *
 * A squash preserves the PATCH while destroying the commit identity, so patch
 * identity is what survives the transformation. `git patch-id --stable`
 * produces a hash of a diff that is independent of commit metadata, parentage
 * and SHA — it is the same mechanism `git cherry` uses to answer "has this
 * change already been applied upstream". Verified on the case above: branch
 * `8a866465` and squash `645da636` both hash to `8ea37575…`.
 *
 * Equivalence is REPORTED, never silently substituted: a presence established
 * by patch identity names the commit that actually carries it, so a receipt
 * says which object in the release the evidence resolved to.
 *
 * ## What this deliberately does not claim
 *
 * Patch identity is not commit identity. A cherry-pick, a rebase and an
 * independently authored identical change are indistinguishable from a squash
 * of the original, and all four mean the work is in the tag — which is the
 * question being asked. It says nothing about authorship or ordering. A merge
 * commit and an empty commit have no patch to hash and can only be answered by
 * reachability.
 *
 * @module
 * @task T12311
 */

import { execFileSync } from 'node:child_process';

/** Subprocess ceiling for the git calls below. */
const SUBPROCESS_TIMEOUT_MS = 60_000;

/** Commits scanned back from the tag when looking for a patch-equivalent. */
export const PATCH_EQUIVALENT_SEARCH_LIMIT = 500;

/** Whether a recorded commit's work is present in a tag, and on what basis. */
export type CommitPresence =
  | {
      /** The work is in the tag. */
      readonly present: true;
      /** The recorded SHA is itself an ancestor of the tag. */
      readonly via: 'ancestor';
      /** The recorded SHA. */
      readonly sha: string;
    }
  | {
      readonly present: true;
      /** The recorded SHA is gone, but its patch is carried by another commit. */
      readonly via: 'patch-equivalent';
      readonly sha: string;
      /** The commit in the tag that carries the identical patch. */
      readonly carriedBy: string;
      /** The shared `git patch-id --stable` hash. */
      readonly patchId: string;
    }
  | {
      /** The work could not be established as present. */
      readonly present: false;
      readonly sha: string;
      /** What was actually checked and what came back. */
      readonly reason: string;
      /** A repair the caller can execute, given verification may be frozen. */
      readonly fix: string;
    };

/** Run git, returning stdout, or `null` when the call fails. */
function git(projectRoot: string, args: readonly string[]): string | null {
  try {
    return execFileSync('git', [...args], {
      cwd: projectRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: SUBPROCESS_TIMEOUT_MS,
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

/** `git patch-id --stable` for one commit, or `null` when it has no patch. */
function patchIdOf(projectRoot: string, sha: string): string | null {
  const out = git(projectRoot, ['show', '--format=%H', '--patch', sha]);
  if (out === null || out.trim().length === 0) return null;
  const hashed = patchIdStream(projectRoot, out);
  const first = hashed.entries().next().value;
  return first === undefined ? null : first[0];
}

/**
 * Hash a `git log --patch` stream into `patchId -> commitSha`.
 *
 * One `git patch-id` invocation for the whole stream: hashing 500 commits with
 * one spawn each is slow enough that a reviewer disables the check.
 */
function patchIdStream(projectRoot: string, stream: string): Map<string, string> {
  const map = new Map<string, string>();
  let out: string;
  try {
    out = execFileSync('git', ['patch-id', '--stable'], {
      cwd: projectRoot,
      input: stream,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: SUBPROCESS_TIMEOUT_MS,
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch {
    return map;
  }
  for (const line of out.split('\n')) {
    const [patchId, commitSha] = line.trim().split(/\s+/);
    // First writer wins: the newest commit carrying a patch is the one the
    // release actually shipped, and `git log` walks newest-first.
    if (patchId && commitSha && !map.has(patchId)) map.set(patchId, commitSha);
  }
  return map;
}

/**
 * Establish whether a recorded commit's work is present in a tag.
 *
 * @param projectRoot - Repository to ask; never inferred from cwd.
 * @param sha - The commit recorded as evidence, which may no longer exist.
 * @param tag - The release tag, or any committish, to look inside.
 * @param searchLimit - Commits scanned back from `tag` for a patch-equivalent.
 * @returns Presence and the basis for it, or an executable repair.
 * @remarks Reachability is asked first and is the strongest answer. Patch
 * identity is consulted only when the SHA is gone, and establishes that the
 * CHANGE shipped, not that the commit did. An unknown object and an absent
 * change are reported differently, because the repairs differ.
 * @example
 * ```ts
 * const found = resolveCommitPresenceInTag(root, sha, 'v2026.9.12');
 * if (found.present && found.via === 'patch-equivalent') record(found.carriedBy);
 * ```
 */
export function resolveCommitPresenceInTag(
  projectRoot: string,
  sha: string,
  tag: string,
  searchLimit: number = PATCH_EQUIVALENT_SEARCH_LIMIT,
): CommitPresence {
  if (git(projectRoot, ['merge-base', '--is-ancestor', sha, tag]) !== null)
    return { present: true, via: 'ancestor', sha };

  // Separate "the tag is unusable" and "the commit is unknown here" from "the
  // change is absent": they are three different repairs, and one message for
  // all three sends the caller to the wrong one.
  if (git(projectRoot, ['rev-parse', '--verify', '--quiet', `${tag}^{commit}`]) === null)
    return {
      present: false,
      sha,
      reason: `tag ${tag} does not resolve to a commit in this repository`,
      fix: `Fetch the tag (git fetch origin tag ${tag}) and re-run; a shallow or stale clone cannot answer reachability.`,
    };

  if (git(projectRoot, ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`]) === null)
    return {
      present: false,
      sha,
      reason: `commit ${sha} is unknown to this repository, so neither its reachability nor its patch can be established`,
      fix: `Fetch the branch that carried ${sha} (git fetch origin '+refs/*:refs/*') and re-run. A squash-merged branch deleted on the remote cannot be recovered; re-plan the release against the commit that shipped it.`,
    };

  const wanted = patchIdOf(projectRoot, sha);
  if (wanted === null)
    return {
      present: false,
      sha,
      reason: `commit ${sha} is not reachable from tag ${tag} and carries no patch to match (a merge or empty commit)`,
      fix: `Record the merge commit that landed this work, or re-plan the release against a commit reachable from ${tag}.`,
    };

  const stream = git(projectRoot, [
    'log',
    `-n${Math.max(1, searchLimit)}`,
    '--format=%H',
    '--patch',
    tag,
  ]);
  const carrier = stream === null ? undefined : patchIdStream(projectRoot, stream).get(wanted);
  if (carrier !== undefined)
    return { present: true, via: 'patch-equivalent', sha, carriedBy: carrier, patchId: wanted };

  return {
    present: false,
    sha,
    reason: `commit ${sha} is not reachable from tag ${tag}, and no commit in the last ${searchLimit} of ${tag} carries its patch (${wanted})`,
    fix: `This change is not in ${tag}. Re-plan the release to exclude the task, or tag a commit that contains the work; re-verifying is refused once a task is done (ADR-051 §11.1), so the release — not the evidence — is what needs correcting.`,
  };
}
