/**
 * Self-improvement probe helper — selfimprove.probe op (T11988).
 *
 * This tiny module exists to give the seeded-code-regression scenario a
 * **real, patchable code bug** for end-to-end fix-gen proof. The function
 * {@link probeVersion} is supposed to return `1` (the canonical probe API
 * version), but ships with an intentional off-by-one (`return 2`) so that a
 * live replay of the `seeded-code-regression` scenario diverges from the
 * golden (`version: 1`) and the LLM can produce a correct one-line unified
 * diff to fix it.
 *
 * ### Why a dedicated file?
 *
 * The seeded bug must be:
 *   1. **In a repo-relative path** the op-source-map can register under
 *      `selfimprove.probe` so the fix-gen context loader includes it in the
 *      LLM prompt.
 *   2. **Minimal** — the simplest possible off-by-one so the model cannot
 *      rationally refuse (`NO_PATCH`).
 *   3. **Self-contained** — no live DB, no side effects; the probe op
 *      never mutates.
 *
 * ### Fixing the bug
 *
 * Change `return 2` → `return 1` in {@link probeVersion}. This is the EXACT
 * one-line fix the self-improvement loop's LLM fix-gen stage should propose
 * when replaying the seeded scenario.
 *
 * @module @cleocode/core/selfimprove/probe-helper
 * @task T11988
 */

/**
 * Return the canonical probe API version.
 *
 * Expected value: `1`.
 *
 * @returns The probe version number.
 *
 * @example
 * ```ts
 * probeVersion(); // => 1 (expected)
 * ```
 *
 * @bug SEEDED — currently returns `2` instead of `1` (T11988 intentional).
 *   The seeded-code-regression scenario golden asserts `version: 1`; the
 *   mismatch is the regression the fix-gen LLM prompt targets.
 */
export function probeVersion(): number {
  // SEEDED BUG (T11988): should be `return 1` — intentional off-by-one for
  // the seeded-code-regression end-to-end fix-gen scenario.
  return 2;
}

/**
 * Build the `selfimprove.probe` response payload.
 *
 * Returns `{ probe: 'ok', version: <probeVersion()> }` — the envelope `data`
 * block the `selfimprove.probe` query op emits.
 *
 * @returns The probe response payload.
 */
export function buildProbePayload(): { probe: 'ok'; version: number } {
  return { probe: 'ok', version: probeVersion() };
}
