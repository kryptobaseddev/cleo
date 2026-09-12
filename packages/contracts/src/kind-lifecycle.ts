/**
 * Per-{@link TaskKind} lifecycle requirements — the SSoT for "how much ceremony
 * does this kind of work actually need?" (gh#494, gh#1215).
 *
 * ## Why this exists
 *
 * CLEO's epic pipeline (`research → consensus → architecture_decision →
 * specification → decomposition → implementation → …`) was calibrated for
 * design-bearing code work, and applied to every epic regardless of what the
 * epic is. A documentation epic, a spike, or a release epic hit the same wall:
 * a child task with complete, honest evidence could not complete until the
 * parent had been walked through five stages that describe nothing about the
 * work.
 *
 * The only escape was four `cleo lifecycle skip --reason` calls plus a
 * `lifecycle start`, per epic. Each skip writes an audit record asserting a
 * deliberate bypass — so routine work generated routine bypass records, which
 * trains everyone to read the audit trail as noise. An audit trail that is
 * mostly ceremony-avoidance is worse than none, because it still looks like
 * evidence.
 *
 * The proposed fix in gh#494 was a new `doc` kind whose semantics are "skip
 * the stages". That encodes an exception rather than answering the question,
 * and the next non-code work type needs a second exception. This table answers
 * the general question instead: the `kind` axis already exists (ADR-066), so
 * each kind declares what it requires.
 *
 * ## What "requires the staged pipeline" means
 *
 * `true` — children cannot complete until the epic has advanced past
 * `decomposition`. Correct when the stages describe real antecedent work:
 * someone must decide the design before the code that implements it is done.
 *
 * `false` — the stages are not a precondition for this kind of work, and the
 * epic's stage does not gate child completion. Evidence gates (ADR-051) are
 * UNAFFECTED: every gate still demands its programmatic proof. This axis
 * governs ceremony, not rigour.
 *
 * @task T12140 (gh#494)
 * @adr ADR-066
 */

import type { TaskKind } from './task.js';

/** What a given {@link TaskKind} requires of the epic lifecycle. */
export interface KindLifecycleRequirement {
  /**
   * Whether children of an epic of this kind are blocked until the epic
   * advances past `decomposition`.
   */
  readonly requiresStagedPipeline: boolean;
  /** Why — surfaced in errors so the rule is legible where it fires. */
  readonly rationale: string;
}

/**
 * The requirement table. Deliberately explicit rather than defaulted: adding a
 * kind should force a decision about what it requires, not inherit one.
 *
 * @task T12140 (gh#494)
 */
export const KIND_LIFECYCLE_REQUIREMENTS: Readonly<Record<TaskKind, KindLifecycleRequirement>> =
  Object.freeze({
    work: {
      requiresStagedPipeline: true,
      rationale:
        'Default delivery work. The staged pipeline exists for exactly this: decide the design before completing the code that implements it.',
    },
    bug: {
      requiresStagedPipeline: false,
      rationale:
        'A fix operates inside an existing design. Demanding consensus and architecture_decision before a fix can complete describes work that is not happening.',
    },
    research: {
      requiresStagedPipeline: false,
      rationale:
        'The research IS the work. Requiring the epic to pass the research stage before its own research children can complete is circular.',
    },
    spike: {
      requiresStagedPipeline: false,
      rationale:
        'A time-boxed exploration whose purpose is to produce the information the design stages would consume. It cannot be gated on having already done so.',
    },
    experiment: {
      requiresStagedPipeline: false,
      rationale:
        'An experiment is run to learn whether an approach holds. Specifying and decomposing it first presumes the answer.',
    },
    release: {
      requiresStagedPipeline: false,
      rationale:
        'Release epics are procedural — the design work they ship was decided in the epics being released.',
    },
  });
