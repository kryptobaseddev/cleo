/**
 * Consolidated **GLOBAL-scope `cleo.db`** target schema — barrel.
 *
 * SG-DB-SUBSTRATE-V2 · saga T11242 · epic T11245 (E2) · task T11361.
 *
 * ## What this directory is
 *
 * The owner-ratified D1″ lifecycle split (2026-05-30) collapses the CLEO SQLite
 * fleet into exactly two `cleo.db` files: a PROJECT-scope DB
 * (`<projectRoot>/.cleo/cleo.db`, authored under `../cleo-project/`) and this
 * GLOBAL-scope DB (`$XDG_DATA_HOME/cleo/cleo.db`). The GLOBAL-scope DB holds
 * every CROSS-PROJECT domain — `nexus_*` (code-intelligence index) / `skills_*`
 * (installed-skills registry) / `signaldock_*` (global agent identity — folded
 * here per D1, no standalone `signaldock.db`) / `brain_*` (cross-project
 * memory) — as domain-prefixed Pattern-A tables.
 *
 * Per the canonical typing report §1 (D1″), the GLOBAL `cleo.db` is
 * **49 tables / 555 columns** = nexus 10 + skills 4 + signaldock 13 + brain 22
 * (MIRRORED). This barrel composes exactly that set.
 *
 * Modules under this directory author the **target shape**: domain-prefixed
 * `sqliteTable` definitions with the E10 strict typing applied per
 * `docs/migration/sqlite-schema-canonical.md`. They are NOT yet the runtime
 * schema — the live runtime modules one level up
 * (`schema/{nexus-schema,code-index,skills-schema,signaldock-schema}.ts`) keep
 * their UNPREFIXED physical names because they back live runtime queries and the
 * journaled drizzle migrations. The **exodus migration (T11248)** swaps the
 * substrate to this shape and renames the physical tables.
 *
 * ## brain_* is MIRRORED — REUSE, never duplicate
 *
 * The `brain_*` memory family (22 tables) is the ONE domain that lives in BOTH
 * the project and global `cleo.db` (project-local vs cross-project memory) —
 * same DDL, two physical DB files, data partitioned by scope. To avoid
 * duplication it is authored ONCE under `../cleo-shared/brain.ts` and re-exported
 * by BOTH scope barrels. This global barrel re-exports the SAME shared module —
 * it does NOT copy or re-author any `brain_*` table. The project barrel
 * (`../cleo-project/index.ts`) re-exports the identical shared module.
 *
 * ## Idempotent prefixer (AC1)
 *
 * Each table's physical name is its `targetTable` from
 * `docs/migration/sqlite-schema-columns.json`. Tables already carrying a
 * recognized domain prefix (`nexus_audit_log`, `nexus_nodes`, …) are NOT
 * double-prefixed; bare tables gain their domain prefix (`project_registry` →
 * `nexus_project_registry`, `code_index` → `nexus_code_index`, `skills` →
 * `skills_skills`, `agents` → `signaldock_agents`, …).
 *
 * ## Coverage (T11361 — global-exclusive authoring COMPLETE · 27 tables + 22 mirrored brain)
 *
 * **Global-exclusive (authored here · 27 tables):**
 *   - **nexus** (10 tables · `./nexus.ts`): nexus_project_registry ·
 *     nexus_project_id_aliases · nexus_audit_log · nexus_schema_meta ·
 *     nexus_nodes · nexus_relations · nexus_contracts · nexus_code_index ·
 *     nexus_user_profile · nexus_sigils. E10: §4 Drizzle-Date → TEXT ISO8601 on
 *     user_profile/sigils timestamps; §5b enums minted for `sigils.role`
 *     (`SIGIL_ROLES`) and `code_index.kind` (`CODE_INDEX_KINDS`).
 *   - **skills** (4 tables · `./skills.ts`): skills_skills · skills_skill_usage
 *     · skills_skill_reviews · skills_skill_patches. Already E10-clean (named
 *     enums + typed booleans + TEXT timestamps).
 *   - **signaldock** (13 tables · `./signaldock.ts`): signaldock_users ·
 *     signaldock_organization · signaldock_agents · signaldock_claim_codes ·
 *     signaldock_capabilities · signaldock_skills · signaldock_agent_capabilities
 *     · signaldock_agent_skills · signaldock_agent_connections ·
 *     signaldock_accounts · signaldock_sessions · signaldock_verifications ·
 *     signaldock_org_agent_keys. E10: §4 epoch → TEXT ISO8601 across cloud-sync
 *     timestamps; §3b `agents.is_active` → typed boolean; §5b enums minted for
 *     `users.role` (`SIGNALDOCK_USER_ROLES`) and `agents.status`
 *     (`SIGNALDOCK_AGENT_STATUSES`). All FKs are intra-domain (single global
 *     file) → kept native `.references()` (AC4).
 *
 * **Mirrored (re-exported · 22 tables):** the `brain_*` family from
 * `../cleo-shared/index.ts` (same module the project barrel uses).
 *
 * **GLOBAL SCHEMA NOW COMPLETE.** 27 global-exclusive prefixed `sqliteTable`s +
 * 22 mirrored brain tables = the canonical 49 (nexus 10 + skills 4 +
 * signaldock 13 + brain 22). What remains for the saga is the exodus cutover
 * (T11248).
 *
 * @task T11361
 * @epic T11245
 * @saga T11242
 * @see docs/migration/sqlite-schema-canonical.md §1 (per-scope counts) · §3–§8 (typing rules)
 * @see ../cleo-shared/brain.ts (the mirrored brain_* family — also imported by cleo-project, T11360)
 * @see ../cleo-project/index.ts (the sibling project-scope barrel)
 * @see drizzle/cleo-global.config.ts (per-scope domain membership)
 */

export * from '../cleo-shared/index.js';
export * from './nexus.js';
export * from './signaldock.js';
export * from './skills.js';
