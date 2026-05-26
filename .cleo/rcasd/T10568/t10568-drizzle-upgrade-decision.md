# T10568: Drizzle rc.3 upgrade timing decision

## Decision

Defer upgrading this repository to `drizzle-orm@1.0.0-rc.3` and `drizzle-kit@1.0.0-rc.3` for now. Continue using hand-written raw SQL migrations for SQLite schema changes that Drizzle beta.22 cannot express or diff deterministically.

## Evidence

- T10565 found that Drizzle rc.3 is a MySQL-focused parity release. Its official release notes explicitly defer the SQLite rework to a future release.
- T10565 also confirmed the current repository is on pre-release beta builds: `drizzle-orm@1.0.0-beta.22-ec7b61d` and `drizzle-kit@1.0.0-beta.19-d95b7a4`.
- T10566 tested the rc.3 ORM+Kit pair together across the repository command surface.
- T10566 found `pnpm db:check` still passes, but `pnpm db:generate` still reaches the same interactive table create/rename prompt path for the existing SQLite schema and is unsuitable for unattended agent/CI use on ambiguous diffs.

## Policy

1. Do not assume rc.3 fixes SQLite limitations; it does not include the deferred SQLite rework.
2. Do not use blind generated migrations against existing project databases when Drizzle prompts for create-vs-rename classification.
3. Keep using hand-written SQL migrations for SQLite edge cases that Drizzle cannot represent in `sqliteTable` definitions or diff deterministically.
4. Reconsider a Drizzle upgrade only when a SQLite-focused release exists, and upgrade `drizzle-orm` and `drizzle-kit` together across root, core, nexus, and playbooks.
5. Any future upgrade attempt must compare `pnpm db:check` and `pnpm db:generate` before/after, preserve non-interactive CI behavior, and document explicit migration-generation policy.

## Acceptance coverage

- AC1: this decision document is attached to T10568 through CLEO docs.
- AC2: the decision explicitly says rc.3 must not be assumed to fix SQLite limitations.
- AC3: the policy forbids blind generated migrations for existing databases.
