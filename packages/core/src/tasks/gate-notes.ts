/**
 * Human-readable notes on passed verification gates (T12961).
 *
 * A flaky pass — a `tool` run whose first attempt failed and whose one full
 * rerun passed — counts toward its gate, but must stay visible rather than
 * read as a clean pass. `cleo verify` and the `cleo show --full` view render
 * such a gate as `passed (flaky: <files>)` from these notes.
 *
 * @task T12961
 */

import type { Task, TaskVerification, VerificationGate } from '@cleocode/contracts';
import { gateProfileOf, implementedCodeEvidence } from './gate-profile.js';

/** The gates a gate profile (T13474) makes not applicable: those that test or lint code. */
export const PROFILE_WAIVED_GATES: readonly VerificationGate[] = ['testsPassed', 'qaPassed'];

/**
 * Notes for the gates a task's gate profile (T13474) makes not applicable:
 * `{ testsPassed: 'not applicable (profile:ops)', … }` for each such gate that
 * is not passed, so a reader never takes it for a pass. Empty when the task
 * declares no profile, or when its implemented evidence carries code (the
 * profile does not apply to it).
 *
 * @param task - The task (labels and recorded evidence are read).
 * @returns The notes, keyed by gate.
 * @task T13474
 */
export function profileGateNotes(
  task: Pick<Task, 'labels' | 'verification'>,
): Partial<Record<VerificationGate, string>> {
  const profile = gateProfileOf(task);
  if (profile === null || implementedCodeEvidence(task) !== null) return {};
  const notes: Partial<Record<VerificationGate, string>> = {};
  for (const gate of PROFILE_WAIVED_GATES) {
    if (task.verification?.gates?.[gate] !== true)
      notes[gate] = `not applicable (profile:${profile})`;
  }
  return notes;
}

/**
 * Notes for every PASSED gate whose evidence carries a flaky `tool` run.
 *
 * @param verification - The task's verification record, if any.
 * @returns e.g. `{ testsPassed: 'passed (flaky: src/a.test.ts)' }`; `{}` when
 *   nothing is flaky.
 *
 * @task T12961
 */
export function describeGateNotes(
  verification: TaskVerification | null | undefined,
): Partial<Record<VerificationGate, string>> {
  const notes: Partial<Record<VerificationGate, string>> = {};
  if (!verification?.evidence) return notes;
  for (const [gate, evidence] of Object.entries(verification.evidence) as Array<
    [VerificationGate, NonNullable<TaskVerification['evidence']>[VerificationGate]]
  >) {
    if (verification.gates[gate] !== true || !evidence) continue;
    const flaky = evidence.atoms.flatMap((a) => (a.kind === 'tool' && a.flaky ? a.flaky : []));
    if (flaky.length > 0) notes[gate] = `passed (flaky: ${[...new Set(flaky)].join(', ')})`;
  }
  return notes;
}
