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

import type { TaskVerification, VerificationGate } from '@cleocode/contracts';

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
