/**
 * @cleocode/playbooks — Playbook DSL + runtime for T889 Orchestration Coherence v3.
 *
 * This package is scaffolded in Wave 0. Subsequent waves will populate:
 * - `schema.ts`     (W4-6)  — types + Drizzle table defs
 * - `parser.ts`     (W4-7)  — .cantbook YAML parser
 * - `state.ts`      (W4-8)  — DB CRUD for playbook_runs + playbook_approvals
 * - `policy.ts`     (W4-9)  — HITL auto-policy rules
 * - `runtime.ts`    (W4-10) — state machine executor
 * - `approval.ts`   (W4-16) — resume token generation + approval ops
 * - `skill-composer.ts` (W4-2..5) — three-source skill bundle composer
 *
 * @remarks
 * Only the {@link PLAYBOOKS_PACKAGE_VERSION} constant is exported from the
 * Wave 0 scaffold. Each follow-up wave adds a named barrel export here.
 *
 * @task T889 Orchestration Coherence v3 — Wave 0 scaffold
 */

/**
 * Package version string matching the monorepo's CalVer cadence.
 *
 * Consumers can use this to assert dependency alignment at runtime
 * (e.g. ensuring the `@cleocode/playbooks` runtime matches CLEO core).
 */
export const PLAYBOOKS_PACKAGE_VERSION: string = '2026.4.85';
