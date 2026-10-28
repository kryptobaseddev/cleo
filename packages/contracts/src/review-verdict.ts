/**
 * Independent per-AC review of a PR (T14122, council run
 * 20261028T155822Z-293ed9f0, blocking amendment 2 of D11211).
 *
 * A reviewer other than the task's author judges each acceptance criterion
 * from the PR diff and the criterion text alone, and records a verdict under
 * its own CLEO session, bound to the PR head it reviewed. The merge sweep
 * (T14101) records `satisfies:` only from a `met` verdict on the merged head;
 * PR text can neither create nor waive one.
 *
 * @task T14122
 */

/** One acceptance criterion as a reviewer sees it: its alias and its text. */
export interface ReviewPacketCriterion {
  /** `AC1`, `AC2`, … */
  alias: string;
  /** The criterion text. */
  text: string;
}

/**
 * What a reviewer is given for one PR and task: the diff at the PR head and
 * the task's criteria. The PR title, body, comments and commit messages are
 * never included, so the author's `Closes:` / `Refs:` lines and summary cannot
 * reach the reviewer.
 */
export interface ReviewPacket {
  /** The PR. */
  prNumber: number;
  /** The PR head the diff was taken at (`headRefOid`). */
  headSha: string;
  /** The task under review. */
  taskId: string;
  /** The task's criteria, in ordinal order. */
  acs: ReviewPacketCriterion[];
  /** The PR diff at `headSha`, without the paths in `withheldPaths`. */
  diff: string;
  /** Changed paths left out of `diff` because they carry the author's own account (changesets). */
  withheldPaths: string[];
  /** sha256 of the head, the criteria and the diff: a verdict names it to prove what was reviewed. */
  packetSha256: string;
}

/** The identities that authored a task: its claim holders and the session that created it. */
export interface ReviewAuthors {
  /** CLEO session ids. */
  sessionIds: string[];
  /** Agent ids (`CLEO_AGENT_ID`, spawn handles). */
  agentIds: string[];
}

/** One reviewer's verdict on one criterion of one task, for one PR head. */
export interface ReviewVerdict {
  /** Verdict id (uuid). */
  id: string;
  /** The task. */
  taskId: string;
  /** The criterion alias (`AC2`). */
  ac: string;
  /** The criterion's stable id (`task_acceptance_criteria.id`). */
  acId: string;
  /** The PR. */
  prNumber: number;
  /** The PR head the reviewer judged (`headRefOid`), never the merge sha. */
  headSha: string;
  /** Whether the diff implements the criterion. */
  verdict: 'met' | 'unmet';
  /** Why, in the reviewer's words. */
  reason: string;
  /** Who reviewed: never one of `authors`. */
  reviewer: { sessionId: string; agentId: string | null };
  /** The task's authors when the verdict was recorded, so a reader can re-check independence. */
  authors: ReviewAuthors;
  /** The {@link ReviewPacket.packetSha256} the reviewer was given. */
  packetSha256: string;
  /** ISO-8601 time it was recorded. */
  createdAt: string;
}

/** Why one criterion has no usable verdict on a head. */
export interface ReviewGap {
  /** The criterion alias. */
  ac: string;
  /**
   * `missing`: none recorded; `unmet`: the latest says unmet; `stale`: only
   * older heads have one; `author`: the latest on the head came from one of
   * the task's own authors (a re-check of the record-time refusal).
   */
  kind: 'missing' | 'unmet' | 'stale' | 'author';
  /** A one-line reason, e.g. `AC2: no verdict on head abc1234 (latest is for 9f00e12)`. */
  reason: string;
}

/** The criteria a set of verdicts proves met on a head, and the gaps. */
export interface ReviewJudgement {
  /** The head judged against. */
  headSha: string;
  /** Criteria whose latest verdict on `headSha` is `met`. */
  met: string[];
  /** Criteria without a `met` verdict on `headSha`, each with why. */
  gaps: ReviewGap[];
}
