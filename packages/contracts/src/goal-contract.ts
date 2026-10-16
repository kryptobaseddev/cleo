/**
 * goal/v1 — the contract a goal runtime executes against, and what CLEO reads
 * back from a run.
 *
 * CLEO owns the goal protocol; OpenCode-Goal (OCG) is the goal runtime (owner
 * decision 2026-10-16, epic T13791). The two stay separate packages and talk
 * only through the `cleo` CLI and LAFS envelopes:
 *
 * 1. `cleo goal draft` writes a {@link GoalContract} (`goal.yaml`) from a
 *    task's acceptance criteria.
 * 2. The runtime locks the contract by the sha256 of its bytes, runs it, and
 *    writes a {@link GoalOutcome}.
 * 3. `cleo goal close` reads the outcome and records evidence for each passing
 *    criterion on the gate it demonstrates, via {@link GoalCriterion.proves}.
 *
 * The shapes mirror OCG's `src/contract/types.ts` field for field, in OCG's
 * snake_case YAML spelling, so one file means the same thing on both sides.
 * The only addition is the optional per-criterion `proves` list.
 *
 * Relation to `GoalRecord` (`goal.ts`): a GoalRecord is CLEO's own
 * per-agent, turn-budgeted loop state, whose criteria are free text. A goal/v1
 * contract is the portable, hash-locked agreement a runtime executes; its
 * criteria carry checks. They share no fields.
 *
 * Types only (gate 10): parsing and validation live in core.
 *
 * @packageDocumentation
 * @module @cleocode/contracts/goal-contract
 *
 * @epic T13791
 * @task T13792
 */

/** The schema tag every goal/v1 contract carries. */
export const GOAL_CONTRACT_SCHEMA = 'goal/v1' as const;

/** Expected result of a {@link GoalCommandCheck}. Absent fields are not checked; no field at all means `exit: 0`. */
export interface GoalCheckExpect {
  /** Required exit code. */
  exit?: number;
  /** Text stdout must contain. */
  stdout_contains?: string;
  /** Regular expression stdout must match. */
  stdout_regex?: string;
}

/** The host runs a shell command and checks its result. */
export interface GoalCommandCheck {
  /** Discriminant. */
  kind: 'command';
  /** Shell command, run from the goal workspace. */
  run: string;
  /** Expected result. */
  expect?: GoalCheckExpect;
  /** Timeout in seconds (runtime default 300). */
  timeout?: number;
  /** Repeat count, 1 to 10; every run must pass. */
  runs?: number;
  /** The command reaches a live service. */
  live?: boolean;
}

/** The host checks that a path exists (or, with `exists: false`, that it does not). */
export interface GoalFileCheck {
  /** Discriminant. */
  kind: 'file';
  /** Workspace-relative path. */
  path: string;
  /** Expected existence (default true). */
  exists?: boolean;
}

/** The host checks that a file contains text or matches a regex. */
export interface GoalContainsCheck {
  /** Discriminant. */
  kind: 'contains';
  /** Workspace-relative path. */
  path: string;
  /** Literal text to find. */
  text?: string;
  /** Regular expression to match. */
  regex?: string;
}

/** The host checks that a pattern occurs nowhere (optionally within `paths`). */
export interface GoalAbsentCheck {
  /** Discriminant. */
  kind: 'absent';
  /** Pattern that must not occur. */
  pattern: string;
  /** Paths to search; absent means the workspace. */
  paths?: string[];
}

/** The host checks that the run changed the given paths since its base commit. */
export interface GoalDiffCheck {
  /** Discriminant. */
  kind: 'diff';
  /** Paths (or globs) that must appear in the diff. */
  paths: string[];
}

/** An independent verifier agent answers the question, citing quotes the host re-reads. */
export interface GoalVerifierCheck {
  /** Discriminant. */
  kind: 'verifier';
  /** Question the verifier must answer. */
  ask: string;
}

/** The owner signs the criterion off. */
export interface GoalHumanCheck {
  /** Discriminant. */
  kind: 'human';
  /** Question the owner answers. */
  ask: string;
}

/** How a criterion is proven. */
export type GoalCheck =
  | GoalCommandCheck
  | GoalFileCheck
  | GoalContainsCheck
  | GoalAbsentCheck
  | GoalDiffCheck
  | GoalVerifierCheck
  | GoalHumanCheck;

/** Discriminant of {@link GoalCheck}. */
export type GoalCheckKind = GoalCheck['kind'];

/** Check kinds the host itself runs; invariants may use only these. */
export const GOAL_HOST_CHECK_KINDS = ['command', 'file', 'contains', 'absent', 'diff'] as const;

/**
 * A CLEO acceptance-criterion reference, `T<digits>#AC<n>`: the task id and
 * the criterion's alias, the same form a `satisfies:` evidence atom takes.
 */
export type GoalAcRef = `T${number}#AC${number}`;

/**
 * One criterion (`C<n>`) or invariant (`I<n>`) of a goal.
 *
 * Invariants are always essential and always host-checked.
 */
export interface GoalCriterion {
  /** `C1`, `C2`, … for criteria; `I1`, `I2`, … for invariants. */
  id: string;
  /** End state that is true when the criterion holds. */
  statement: string;
  /** The goal is not done until every essential criterion passes. */
  essential: boolean;
  /** How the criterion is proven. */
  check: GoalCheck;
  /**
   * CLEO acceptance criteria this criterion's evidence demonstrates. When the
   * criterion passes, `cleo goal close` links its evidence to each one with
   * `satisfies:`. Absent means the criterion proves no CLEO AC.
   */
  proves?: GoalAcRef[];
}

/** A decision the agent made without the owner, open to veto. */
export interface GoalAssumption {
  /** `A1`, `A2`, … */
  id: string;
  /** What was assumed. */
  text: string;
  /** Why. */
  rationale?: string;
  /** Whether it can be undone cheaply. */
  reversible?: boolean;
  /** Owner disposition. */
  status: 'assumed' | 'confirmed' | 'vetoed';
}

/** One plan step. */
export interface GoalStep {
  /** `S1`, `S2`, … */
  id: string;
  /** What the step does. */
  title: string;
  /** Criterion ids the step proves. */
  proves: string[];
  /** Step ids that must finish first. */
  depends_on: string[];
}

/** Optional goal priority; absent sorts last. */
export type GoalPriority = 'low' | 'medium' | 'high';

/**
 * Run budget. In YAML, `wall` is a duration (`"90m"`) and `tokens` a count
 * (`400k`); the parsed form holds milliseconds and integers.
 */
export interface GoalBudget {
  /** Agent turns. */
  turns?: number;
  /** Active wall-clock time, milliseconds (YAML `wall`). */
  wallMs?: number;
  /** Input + output + reasoning tokens. */
  tokens?: number;
  /** Spend ceiling in US dollars. */
  cost_usd?: number;
}

/** Contract changes the owner lets the agent apply to its own contract. */
export type GoalAmendClass = 'timeout' | 'budget' | 'plan' | 'recover';

/** Owner-set autonomy policy. */
export interface GoalAutonomy {
  /** Whether the agent may ask the owner questions mid-run (`defer` queues them). */
  questions: 'defer' | 'allow';
  /** What an owner message does to a running goal. */
  on_user_message: 'steer' | 'pause';
  /** What an interrupt does. */
  on_interrupt: 'pause' | 'resume-on-message';
  /** Amendment classes the agent may apply itself (default none). */
  amend: GoalAmendClass[];
  /** What the stall detector does. */
  on_stall: 'pause' | 'continue';
}

/** How completion is decided. */
export type GoalVerificationMode = 'host' | 'host+verifier' | 'strict';

/** The CLEO evidence gates a goal can declare evidence for. */
export type GoalCleoGate = 'implemented' | 'testsPassed' | 'qaPassed';

/**
 * A CLEO task the goal serves (OCG `CleoTaskLink`).
 *
 * The bare id links the task for reporting. `acs` is OCG's older per-gate
 * claim of which AC aliases a gate's evidence proves; per-criterion
 * {@link GoalCriterion.proves} is the precise form and what `cleo goal draft`
 * writes. An AC neither form claims stays open.
 */
export interface GoalTaskLink {
  /** Task id (`T123`). */
  id: string;
  /** Per-gate AC aliases (`AC1`, …) the gate's evidence proves. */
  acs?: Partial<Record<GoalCleoGate, string[]>>;
}

/** A goal/v1 contract: written by the owner (or `cleo goal draft`), locked by hash when a run starts. */
export interface GoalContract {
  /** Always {@link GOAL_CONTRACT_SCHEMA}. */
  schema: typeof GOAL_CONTRACT_SCHEMA;
  /** Kebab-case slug; equals the goal's directory name. */
  id: string;
  /** Short title (under 80 characters). */
  title: string;
  /** Optional priority. */
  priority?: GoalPriority;
  /** `"<slug>@<lock-prefix>"` of the goal this one replaces. */
  supersedes?: string;
  /** The owner's own words, kept verbatim as the authoritative source. */
  intent: { verbatim: string };
  /** The one end state that is true when the goal is done. */
  outcome: string;
  /** Why the goal matters. */
  why?: string;
  /** What is in and out of scope. */
  scope: { in: string[]; out: string[] };
  /** At least one non-goal. */
  non_goals: string[];
  /** Constraints the run must respect. */
  constraints: string[];
  /** At least one criterion, at least one essential. */
  criteria: GoalCriterion[];
  /** Host-checked conditions that must hold throughout. */
  invariants: GoalCriterion[];
  /** Root-relative execution workspace (default: project root). */
  workspace?: string;
  /** The CLEO tasks this goal serves. Absent means no CLEO behaviour. */
  cleo?: { tasks: GoalTaskLink[] };
  /** Paths the agent must not modify. */
  protect: string[];
  /** Decisions made without the owner. */
  assumptions: GoalAssumption[];
  /** Ordered plan. */
  plan: GoalStep[];
  /** Run budget. */
  budget: GoalBudget;
  /** Stop conditions. */
  stop: { when?: string; escalate_when: string[] };
  /** Autonomy policy. */
  autonomy: GoalAutonomy;
  /** Verification policy. */
  verification: {
    /** How completion is decided (default `host+verifier`). */
    mode: GoalVerificationMode;
    /** Verifier rejections before the run escalates, 1 to 10 (default 3). */
    max_rejections: number;
    /** Folders the verifier may read. */
    read: string[];
    /** Verifier model, `providerID/modelID[#variant]`. */
    model?: string;
    /** Verifier effort. */
    effort?: string;
  };
  /** Execution settings. */
  execution: { agent?: string };
  /** Free-form metadata: any YAML value, opaque to CLEO. */
  meta: Record<string, unknown>;
}

/** Who produced a criterion's verdict. */
export type GoalVerdictSource = 'host' | 'verifier' | 'verifier-fallback' | 'human';

/** A quote the verifier cited, which the host re-read from the file. */
export interface GoalVerifierQuote {
  /** Workspace-relative path. */
  path: string;
  /** Exact text quoted. */
  quote: string;
}

/** Evidence of a passing or failing `command` check. */
export interface GoalCommandEvidence {
  /** Discriminant. */
  kind: 'command';
  /** The command as run. */
  command: string;
  /** Exit code of the last run. */
  exitCode: number;
  /**
   * Path of a vitest-shaped JSON report the command wrote, when it ran tests.
   * `cleo goal close` records it as a `test-run:` atom.
   */
  reportPath?: string;
  /** Test files the report covers. */
  testFiles?: string[];
}

/** Evidence of a `file`, `contains`, `absent` or `diff` check. */
export interface GoalPathEvidence {
  /** Discriminant: the check kind that ran. */
  kind: 'file' | 'contains' | 'absent' | 'diff';
  /** Repo-relative paths the check examined. */
  paths: string[];
}

/** Evidence of a verifier check. */
export interface GoalVerifierEvidence {
  /** Discriminant. */
  kind: 'verifier';
  /** The verifier's verdict. */
  verdict: 'proven' | 'not_proven' | 'contradicted';
  /** Quotes the verifier cited. */
  quotes: GoalVerifierQuote[];
  /** The verifier's reason. */
  reason?: string;
}

/** Evidence of a human sign-off. */
export interface GoalHumanEvidence {
  /** Discriminant. */
  kind: 'human';
  /** Who signed off. */
  by?: string;
  /** The owner's note. */
  note?: string;
}

/** What a criterion's check produced. */
export type GoalCheckEvidence =
  | GoalCommandEvidence
  | GoalPathEvidence
  | GoalVerifierEvidence
  | GoalHumanEvidence;

/** The verdict on one criterion or invariant. */
export interface GoalCriterionOutcome {
  /** Criterion or invariant id (`C1`, `I1`). */
  id: string;
  /** Whether it passed. */
  pass: boolean;
  /** Who decided. */
  by: GoalVerdictSource;
  /** Human-readable detail. */
  detail?: string;
  /** What the check produced. */
  evidence: GoalCheckEvidence;
}

/**
 * What a goal run produced, written by the runtime and read by
 * `cleo goal close`.
 *
 * `lock` ties the outcome to the exact contract bytes; `headCommit` is the
 * tree the checks ran on.
 */
export interface GoalOutcome {
  /** Always `goal-outcome/v1`. */
  schema: 'goal-outcome/v1';
  /** Goal slug ({@link GoalContract.id}). */
  goal: string;
  /** Runtime run id. */
  runId?: string;
  /** sha256 (hex) of the `goal.yaml` bytes the run locked. */
  lock: string;
  /** Commit the run started from (the diff base), or null when none. */
  baseCommit: string | null;
  /** Commit the checks ran on. */
  headCommit: string;
  /** Per-criterion and per-invariant verdicts. */
  results: GoalCriterionOutcome[];
}
