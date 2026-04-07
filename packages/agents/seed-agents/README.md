# CleoOS Seed Agents

Canonical `.cant` agent personas bundled with `@cleocode/agents`. These six
seeds form the default CleoOS team — orchestrators, developers, lore keepers,
and subsystem leads — and are installed into a project's `.cleo/agents/`
directory on demand by `cleo init --install-seed-agents`.

Operators are encouraged to fork, edit, or delete any of these files. They are
the *starting* personas, not a fixed contract. Re-running `cleo init` never
overwrites a seed that already exists in the project.

## Bundled personas

### `cleo-prime.cant`
The supreme orchestrator persona. Holds the role of `specialist` under the
legacy `cleoos-opus-orchestrator` parent and represents the canonical
"prime" voice of the CleoOS team. Ships as a bare scaffold so each project can
fill in its own tone, prompt, and enforcement rules.

### `cleo-dev.cant`
General-purpose development agent. Builds features, fixes bugs, writes tests,
and runs `/simplify` to keep code quality high. Doesn't own a specific
domain — it goes where the work is. Read first, build second, verify always.

### `cleo-historian.cant`
Canon guardian and lore keeper. Holds the team accountable to CLEO naming
conventions, architectural decisions, and the broader ecosystem vocabulary.
Pushes back on terminology drift and unverified claims. Direct, authoritative,
firm — never lets things slide.

### `cleo-rust-lead.cant`
Project lead for the Rust crate ecosystem (cant-core, cant-napi, cant-lsp,
cant-runtime). Ship-oriented, intolerant of idle agents or unfinished stubs.
Owns crate architecture and unblocks downstream agents on Rust questions.

### `cleo-db-lead.cant`
Database lead for the CleoCode and SignalDock ecosystems. Schema authority,
type safety enforcer, single-source-of-truth guardian. Watches Drizzle and
Diesel schema files and flags type/build hygiene after edits.

### `cleoos-opus-orchestrator.cant`
Legacy "Sovereign of the Circle" orchestrator persona kept for reference and
back-compat. Coordinates across projects, manages agent lifecycle, and
escalates stale agents. New deployments should prefer `cleo-prime` as the
canonical orchestrator entry point.

## Installation

Seeds are NOT installed by default. To opt in during project init:

```bash
cleo init --install-seed-agents
```

This copies any seed file that does not already exist in `.cleo/agents/`. The
flag is idempotent and safe to run on already-initialised projects.

## Validation

All six seeds validate clean against the CANT 42-rule type and grammar suite:

```bash
for f in seed-agents/*.cant; do cleo cant validate "$f"; done
```

Each must return `valid: true` with `errorCount: 0`.
