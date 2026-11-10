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
  /**
   * sha256 of the criterion's normalised text as the packet showed it
   * (T14259). An edit after the verdict invalidates it; a verdict recorded
   * before this field existed has none.
   */
  acTextSha256?: string;
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
  /**
   * The id of an earlier non-author `unmet` verdict on the same head that
   * this `met` answers (T14128). Without it, a later `met` cannot clear that
   * `unmet`, so shopping for a friendlier reviewer stays visible.
   */
  answers?: string;
  /**
   * A shadow verdict (T14372): recorded with every independence check, under
   * `review.shadow-verdict`, and never counted toward a merge.
   */
  shadow?: true;
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
   * the task's own authors (a re-check of the record-time refusal); `edited`:
   * the criterion's text changed after the latest verdict on the head (T14259).
   */
  kind: 'missing' | 'unmet' | 'stale' | 'author' | 'edited';
  /** A one-line reason, e.g. `AC2: no verdict on head abc1234 (latest is for 9f00e12)`. */
  reason: string;
}

/**
 * An `unmet` verdict a later `met` answered on the same head (T14137), so an
 * owner can see who cleared whose finding.
 */
export interface ReviewAnswer {
  /** The criterion. */
  ac: string;
  /** The answered `unmet` verdict and its reviewer. */
  unmet: { id: string; reviewer: ReviewVerdict['reviewer'] };
  /** The `met` verdict that answered it and its reviewer. */
  met: { id: string; reviewer: ReviewVerdict['reviewer'] };
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

/**
 * Who reviews a PR (T14372, owner decision 2026-11-10): `routine` PRs go to a
 * dispatched reviewer worker; `lead` PRs (migrations, store or sync code,
 * gates, deletions, evidence code) stay with the lead.
 */
export type ReviewRoute = 'routine' | 'lead';

/** Why a PR is lead-reserved: the kind of path and the path itself. */
export interface ReviewRouteReason {
  /** `migration`, `store-sync`, `gate`, `deletion` or `evidence`. */
  kind: 'migration' | 'store-sync' | 'gate' | 'deletion' | 'evidence';
  /** The changed path that reserved it. */
  path: string;
}

/** A PR's route and every path that reserved it for the lead. */
export interface ReviewRouting {
  /** The route. */
  route: ReviewRoute;
  /** Empty for `routine`. */
  reasons: ReviewRouteReason[];
}

/** One reviewer dispatch, recorded per task as a `review.dispatch` audit row. */
export interface ReviewDispatch {
  /** The PR. */
  prNumber: number;
  /** The PR head the reviewer is sent to judge. */
  headSha: string;
  /** The task under review. */
  taskId: string;
  /** The criteria to judge. */
  acs: string[];
  /** `shadow`: the reviewer records shadow verdicts, which never count; `counted`: real verdicts. */
  mode: 'shadow' | 'counted';
  /** The agent id the reviewer runs under: never one of the task's authors. */
  reviewerAgentId: string;
  /** The session that dispatched (never the reviewer's). */
  dispatcherSessionId: string | null;
  /** ISO-8601 time it was recorded. */
  dispatchedAt: string;
}

/** What a dispatch run did, or would do, with one open PR. */
export interface ReviewDispatchDecision {
  /** The PR. */
  prNumber: number;
  /** The head judged. */
  headSha: string;
  /**
   * `dispatch`: a reviewer is sent (dry run: would be). `dispatched-already`:
   * this head already has one in this mode. `lead`: lead-reserved, never
   * dispatched. `skip`: nothing to review; `reason` says why.
   */
  action: 'dispatch' | 'dispatched-already' | 'lead' | 'skip';
  /** Why. */
  reason: string;
  /** The route, once the diff was read. */
  routing?: ReviewRouting;
  /** The dispatches recorded (or, on a dry run, that would be), one per task. */
  dispatches?: ReviewDispatch[];
  /** The brief to hand the reviewer agent, for `dispatch`. */
  brief?: string;
}

/** One criterion's shadow verdict next to the counted one on the same head (T14372). */
export interface ReviewShadowComparison {
  /** The criterion. */
  ac: string;
  /** The latest counted verdict on the head, or null. */
  lead: 'met' | 'unmet' | null;
  /** The latest shadow verdict on the head, or null. */
  shadow: 'met' | 'unmet' | null;
  /** Both present and equal. */
  agree: boolean;
}

/** Result of a reviewer dispatch run (`cleo review dispatch`, T14372). */
export interface ReviewDispatchResult {
  /** Nothing was recorded. */
  dryRun: boolean;
  /** The verdict kind the reviewers are sent to record. */
  mode: 'shadow' | 'counted';
  /** False when no PR was judged; `skippedReason` says why. */
  ran: boolean;
  /** Why it did not run. */
  skippedReason?: string;
  /** One decision per open PR, in PR-number order. */
  decisions: ReviewDispatchDecision[];
}
