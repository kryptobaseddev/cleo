/**
 * AsyncLocalStorage-backed write-origin tracker for skill mutations.
 *
 * TypeScript port of Hermes' `tools/skill_provenance.py`. Used by the skills
 * subsystem (council, auto-improve, curator) to tag every `skills.db` write
 * with the originating execution context so we can:
 *
 *   1. Refuse mutations against `canonical` rows when the origin is anything
 *      but `'pr-generator'` (Sphere A is owner-CI-only per architecture §4).
 *   2. Attribute background-review patches in the audit log so the operator
 *      can `cleo audit show` them post-hoc without re-running the workflow.
 *
 * ## Surface
 *
 * - {@link SkillWriteOrigin}      — the three valid origins (literal union).
 * - {@link setCurrentWriteOrigin} — push the origin onto the ALS frame.
 * - {@link getCurrentWriteOrigin} — read the active origin (or `undefined`).
 * - {@link withProvenance}        — scoped helper: run `fn` inside an ALS
 *                                    frame, restore the prior origin on exit.
 *
 * ## Why AsyncLocalStorage?
 *
 * Skill mutations can fan out across async boundaries (LLM streaming, drizzle
 * queries, file IO). Threading an explicit origin parameter through every
 * call site would bloat 30+ helpers; ALS gives us per-async-context isolation
 * with no parameter pollution. Node 16+ supports ALS in stable.
 *
 * @task T9705
 * @epic T9571
 * @saga T9560
 * @port-of tools/skill_provenance.py (Hermes Agent)
 * @architecture docs/architecture/SG-CLEO-SKILLS-architecture-v3.md §4-§6
 */

import { AsyncLocalStorage } from 'node:async_hooks';

// ---------------------------------------------------------------------------
// Type — three valid write origins, mirrored from Hermes
// ---------------------------------------------------------------------------

/**
 * The set of valid execution contexts for a skills.db write.
 *
 * - `'foreground'`        — A user-driven CLI invocation (e.g. `cleo skills add`).
 *                            Allowed to mutate `user`/`agent-created` rows.
 * - `'background-review'` — The auto-improve council/grade pipeline running
 *                            under the sentient daemon. Allowed to mutate
 *                            `user`/`community` rows when an approved review
 *                            is in scope.
 * - `'pr-generator'`      — The owner-CI workflow that synthesises Sphere A
 *                            canonical rows from the upstream skills repo.
 *                            ONLY origin permitted to write `canonical` rows.
 */
export type SkillWriteOrigin = 'foreground' | 'background-review' | 'pr-generator';

// ---------------------------------------------------------------------------
// AsyncLocalStorage instance — module-singleton (per-process)
// ---------------------------------------------------------------------------

/**
 * Module-private ALS instance. Single per process — the AsyncLocalStorage
 * contract is that a fresh instance starts with no active frame, and frames
 * are inherited across awaited async boundaries automatically.
 *
 * Exposed indirectly via the four helpers below; never imported by callers.
 */
const writeOriginStorage = new AsyncLocalStorage<SkillWriteOrigin>();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Set the active write origin for the CURRENT async frame.
 *
 * Equivalent to {@link AsyncLocalStorage#enterWith} — the origin is visible
 * to every `getCurrentWriteOrigin()` call made on the same async chain
 * from this point forward, until the frame exits.
 *
 * Prefer {@link withProvenance} when you can scope the origin to a single
 * callable; only use `setCurrentWriteOrigin` when no clean enclosing scope
 * exists (e.g. inside a long-running daemon event-loop tick).
 *
 * @param origin - The origin to associate with subsequent writes.
 *
 * @task T9705
 */
export function setCurrentWriteOrigin(origin: SkillWriteOrigin): void {
  writeOriginStorage.enterWith(origin);
}

/**
 * Read the active write origin for the CURRENT async frame.
 *
 * Returns `undefined` when no origin has been set in the enclosing scope —
 * call sites that REQUIRE an origin (e.g. canonical-row write paths) MUST
 * treat `undefined` as a hard failure and throw, not silently default.
 *
 * @returns The active origin, or `undefined` when none is set.
 *
 * @task T9705
 */
export function getCurrentWriteOrigin(): SkillWriteOrigin | undefined {
  return writeOriginStorage.getStore();
}

/**
 * Run `fn` inside a fresh ALS frame with `origin` active for its duration.
 *
 * The previous origin (if any) is automatically restored when `fn` resolves
 * or rejects — no manual stack management needed.
 *
 * @example
 * ```typescript
 * await withProvenance('pr-generator', async () => {
 *   await bulkImportFromHermes(entries); // origin === 'pr-generator'
 * });
 * // origin is now whatever it was before the call (undefined in this case).
 * ```
 *
 * @typeParam T - Return type of `fn`.
 * @param origin - The origin to install for the duration of `fn`.
 * @param fn - The callable to run inside the provenance frame. May be sync
 *   or async — the ALS frame is preserved across awaited boundaries.
 * @returns Whatever `fn` returns (awaited).
 *
 * @task T9705
 */
export function withProvenance<T>(origin: SkillWriteOrigin, fn: () => T | Promise<T>): Promise<T> {
  return writeOriginStorage.run(origin, async () => {
    return fn();
  });
}
