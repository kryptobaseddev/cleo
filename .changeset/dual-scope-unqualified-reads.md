---
id: dual-scope-unqualified-reads
tasks: [T12156]
kind: fix
summary: Gate unqualified SQL reads of tables resident in both cleo.db scopes — a bare name answers without saying which file it read
---

**gh#1283.** 35 tables exist in both the project `cleo.db` and the global
`cleo.db`, and both files can be visible on one connection at once. An
unqualified `SELECT count(*) FROM __drizzle_migrations` then resolves by
SQLite's search order and returns a confident number that never says which file
it came from. Measured on this repo: project 108, global 14 — the bare query
answers 108.

**The mechanism is not dual-scope.** `openDualScopeDb` performs no ATTACH at
all. The attach comes from `ensureGlobalRegistryAttached()` in
`store/nexus-sqlite.ts`, which binds the global `cleo.db` onto the *project*
handle as `nexus_global` so nexus registry tables resolve by bare name through
SQLite's fall-through. And because `bindProjectDomain` resolves through one
path-keyed native handle shared by every project-scope domain, that attach is
process-global and retroactive — a domain bound before anything touched nexus
has its own handle gain a second schema underneath it:

```
sibling domain BEFORE nexus: ["main"]
sibling domain AFTER  nexus: ["main","nexus_global"]   (same native object)
```

So the ambiguity window is not "nexus code". It is any project-scope domain,
at any point after anything in the process has touched nexus.

**The rule is deliberately narrow.** Nexus *depends* on bare names falling
through to the attached global schema, so "qualify every read" would break it.
The correct rule — and what this gate encodes — is: qualify the tables that
exist in **both** schemas; leave bare names alone for tables that exist in one.

`scripts/lint-dual-scope-unqualified-reads.mjs` derives the ambiguous set from
`schema/cleo-shared/` plus an explicit infra list (`__drizzle_migrations`,
`_writer_leases`, `_writer_queue`, `brain_schema_meta` — the last is created by
raw SQL and cannot be derived from any `sqliteTable` declaration). Baselined at
414 references across 64 files; forward-only.

Registered as gate 21 in both `cleo check arch` and the AGENTS.md table, so
gate 20 (arch-gate parity) stays satisfied.

Severity, stated plainly: **latent, not live.** Every shipped read site was
checked and none returns a wrong answer today — `computeMigrationCoverage` runs
on a single-schema snapshot handle, the agent-registry count runs on a
global-bound handle, and the sentient nexus ingester is handed the
project-bound handle. What this closes is the next one, plus the diagnostic
hazard that found it: an operator querying migration state when something looks
broken gets an answer with no cue to be suspicious.
