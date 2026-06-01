---
id: t11525-e6-l5-signaldock-skills-dual-scope
tasks: [T11525]
kind: refactor
summary: route signaldock-sqlite + skills-db through openDualScopeDb('global') and resolve the cross-domain bare-skills collision (E6-L5)
---

E6-L5 of the SG-DB-SUBSTRATE-V2 store rewrite (saga T11242, epic T11249). Routes both global-tier domains through the canonical dual-scope chokepoint and removes their raw `new DatabaseSync()` opens.

- `signaldock-sqlite.ts` — `ensureGlobalSignaldockDb()` now delegates the open to `openDualScopeDb('global')`, extracts the `$client` native handle, and runs the legacy `drizzle-signaldock` migrations on it. signaldock's legacy BARE table names (`agents`, `capabilities`, `skills`, …) DIFFER from the consolidated `signaldock_*` prefix, so they co-exist in the shared global `cleo.db` (the conduit-L3 / tasks DIFFER-PREFIX pattern).
- `skills-db.ts` — `openSkillsDb()` now delegates to `openDualScopeDb('global')` and binds the (prefix-renamed) `skillsSchema` drizzle queries directly to the consolidated `skills_skills` / `skills_skill_usage` / `skills_skill_reviews` / `skills_skill_patches` tables that the `drizzle-cleo-global` migration already creates. The legacy `drizzle-skills` migration is NOT run on the shared handle.

Why skills renames instead of running its legacy migration: consolidating both former-separate-file domains onto ONE `cleo.db` introduced a SAME-NAME collision — signaldock's legacy `skills` slug-catalog and skills-db's legacy `skills` registry both wanted the bare physical name `skills`. An empirical migration-ordering probe confirmed the collision is fatal in both orderings, AND that the consolidated `skills_skills` CHECK constraints (timestamp-GLOB, boolean IN(0,1), enum) accept every value the runtime drizzle writers produce. So no establishLegacy drop+rebuild is needed (unlike nexus L4) — skills-db simply lands on its exodus-target prefixed tables, making it a zero-delta cutover for the skills domain.

Supporting changes: a new `openDualScopeDbAtPath(scope, dbPath)` chokepoint sibling preserves the skills-db `{ path }` test override; scope-filtered cache reset in both domains' close/reset paths honors the L4 shared-handle rule (signaldock/skills must not close the global handle co-owned by nexus); `backup-pack.ts` reads the literal legacy `signaldock.db` filename during cutover (matching the nexus L4 treatment); and `project-health.ts` folds `SIGNALDOCK_DB` onto the global `cleo.db` floor. DB Open Guard Gate 3 stays green (0 violations).
