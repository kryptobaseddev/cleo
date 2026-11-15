# CLEO Architecture Guide

How the parts of CLEO fit together, in plain words. Read this before the
formal specs. Checked against the code on 2026-11-15 (T14108); where this guide
and the code disagree, the code wins.

## What CLEO is

CLEO is a harness-agnostic core for agent work (ADR-098, D11170). It has no
agent loop of its own. Agents run inside a harness (Claude Code, Codex,
OpenCode, Kimi, Gemini and others) and call CLEO through the `cleo` CLI. Every
call returns one LAFS envelope on stdout (ADR-086).

CLEO can start a harness, but it does not run it.
`cleo orchestrate spawn-execute` launches a worker: it calls the provider
adapter's `spawn()` (`packages/core/src/orchestrate/spawn-ops.ts`), which
starts the harness CLI as a child process, for example `claude`, `codex` or
`opencode` (`packages/adapters/src/providers/*/spawn.ts`). Some adapters
cannot spawn; Cursor's throws. Run inside Orca, the launch goes through Orca's
execution port (`OrcaRoutingAdapter`) and the worker opens in an Orca
terminal. From then on, the turns, tools and model belong to the
harness.

CLEO keeps the state that outlives one agent session:

- the work (tasks, epics, acceptance criteria, evidence);
- the lifecycle each piece of work is in;
- what agents learned (memory and decisions);
- the canonical docs;
- the links between projects and their code.

CLEO used to plan its own harness: Pi, then the CleoOS distribution around it.
ADR-098 retired that plan. `@cleocode/cleo-os` and the Pi surfaces are frozen
for removal, and nothing in the core loop imports them.

## The Six Great Systems

| System | What it holds | Where to start |
|---|---|---|
| **TASKS** | Work: epics, tasks, subtasks, dependencies, acceptance criteria, evidence gates, claims, audit history | `cleo focus <id>`, `cleo find`, `cleo show <id> --full` |
| **LOOM** | The lifecycle: research, consensus, architecture decision, specification, decomposition, implementation, validation, testing, release, plus a cross-cutting contribution stage (`packages/core/src/lifecycle/stages.ts`) | `cleo lifecycle`, `cleo orchestrate` |
| **BRAIN** | Memory: observations, lessons, decisions and the links between them, searched cheaply first and fetched in full only when needed | `cleo memory find`, `timeline`, `fetch`, `observe` |
| **NEXUS** | The project registry and code intelligence: which projects exist on this machine, and a symbol graph for impact and context queries | `cleo nexus impact <symbol>`, `cleo nexus context` |
| **Docs store** | Canonical docs (ADRs, specs, guides, plans and the rest) as content-addressed blobs; `docs/` holds published mirrors (ADR-076) | `cleo docs query`, `fetch`, `update`, `publish` |
| **CANT** | The agent definition language: `.cant` files that declare agents, skills, hooks and workflows, parsed and validated by `@cleocode/cant` | [CANT reference](../reference/cant.md) |

BRAIN, NEXUS and the docs store are systems, not files. Each has its own
search, linking and repair verbs. Reach them through `cleo`, never by reading
the database.

## Around the core

These run beside CLEO and talk to it through the CLI or a published contract:

- **AgentMBX** carries every agent-to-agent message, same project or across
  machines: one mailbox, one inbox, one history (D11176). CLEO runs no message
  transport of its own. Conduit survives only as a thin client over AgentMBX,
  and SignalDock is retired.
- **Orca** launches workers in harness terminals, supervises them and relays
  their reports to the lead over AgentMBX (D11242, epic T14451).
- **CLEO Goal** (`@cleocode/goal`, bin `cleo-goal`) is the one autonomous
  driver (ADR-097). It keeps an agent working toward a `goal/v1` contract
  through the harness's own Stop hook, and talks to CLEO only through the CLI.
  `cleo goal draft|install|status|close` manages it from the CLEO side.
  `cleo goal install --harness` supports `opencode` (through
  `cleo-goal install --project`), `claude` and `codex` (through the project
  Stop dispatcher, `cleo hook stop`). `hermes` and `kimi` refuse with
  `E_NOT_IMPLEMENTED` until their pilot lands (T13822;
  `packages/core/src/goal/runtime.ts`).
- **CAAMP** (`@cleocode/caamp`) is the provider registry and package manager
  for agent harnesses. It knows each provider's config, skills and instruction
  files, and owns the managed instruction blocks CLEO writes into them.
- **Provider adapters** (`@cleocode/adapters`) deliver CLEO's instructions and
  hooks into each harness.
- **LAFS** (`@cleocode/lafs`) is the envelope format every `cleo` call returns
  ([LAFS envelope contract](../spec/lafs-envelope-contract.md)).
- **Skills** (`packages/skills/skills/`) are the `ct-*` instructions spawned
  agents read ([skills architecture](skills-architecture.md)).

## Where the data lives

CLEO keeps its state in one SQLite file per scope, opened only through
`openDualScopeDb` (`packages/core/src/store/dual-scope-db.ts`):

| Scope | File | Holds |
|---|---|---|
| Project | `<project>/.cleo/cleo.db` | `tasks_*` (tasks, sessions, lifecycle, provenance, playbooks), project `brain_*` memory, `docs_*`, `conduit_*`, and the project's NEXUS code graph (`nexus_nodes`, `nexus_relations` and others) |
| Global | `<cleoHome>/cleo.db` | the NEXUS project registry (`nexus_*`), `agent_registry_*`, `skills_*`, `telemetry_*`, accounts, providers, models, services, and global `brain_*` memory |

The schemas are `packages/core/src/store/schema/cleo-project/`,
`cleo-global/`, and `cleo-shared/` (the `brain_*` tables both scopes carry).

`<cleoHome>` is `~/.local/share/cleo` on Linux and
`~/Library/Application Support/cleo` on macOS; `CLEO_HOME` overrides it.

Small `tasks.db` files and `tasks-*.db` backup snapshots are decoys. Never read
`.cleo/*.db` directly; `cleo doctor superseded-store` proves which store holds
the data. Doc content lives in the blob store under `.cleo/blobs/`, and the
`docs_publications` table records which blob each `docs/` mirror was written
from.

`.cleo/cleo.db` and the other runtime files are never committed. The identity
files `.cleo/project.json` and `.cleo/project-id` are (ADR-094, ADR-096).

## Dispatch domains (once the Circle of Eleven)

Every operation is addressed as `{domain}.{operation}` (for example
`tasks.add`, `memory.observe`) through one of two gateways: `query` (reads,
never change state) or `mutate` (writes). The closed list of domains is
`CANONICAL_DOMAINS` in `packages/contracts/src/dispatch/identity.ts`, 28 in all:

| Group | Domains |
|---|---|
| Work | `tasks`, `session`, `focus`, `sticky`, `attention` |
| Lifecycle and release | `pipeline`, `check`, `release`, `upgrade`, `worktree`, `playbook` |
| Knowledge | `memory`, `docs`, `nexus`, `intelligence`, `provenance` |
| Agents | `orchestrate`, `tools`, `sentient`, `selfimprove` |
| Models and services | `llm`, `account`, `provider`, `model`, `profile`, `service` |
| System | `admin`, `diagnostics` |

The registry (`packages/cleo/src/dispatch/registry.ts`) and the
[operation constitution](../spec/cleo-operation-constitution.md) list each
domain's operations. Messaging is not a domain: T13955 removed `conduit` when
messaging moved to AgentMBX. The "Circle of Eleven" was the original eleven
domains, from `tasks` to `intelligence`; the other seventeen came later.

## Request flow

Every CLI operation takes the same path:

1. **Parse.** The command (`packages/cleo/src/cli/commands/`, built with
   `defineCommand`) parses flags into a dispatch request through the CLI adapter
   (`packages/cleo/src/dispatch/adapters/cli.ts`).
2. **Resolve.** The dispatcher (`@cleocode/runtime/gateway`) looks up the
   operation by domain and name in the registry
   (`packages/cleo/src/dispatch/registry.ts`, described by
   `packages/contracts/src/dispatch/operations-registry.ts`) and checks required
   parameters. An unknown or removed operation fails; there is no fallback.
3. **Middleware.** The CLI dispatcher (`createCliDispatcher` in
   `packages/cleo/src/dispatch/adapters/cli.ts`) runs, in order: store write
   guard, session resolver, write actor, claim heartbeat, sanitizer, field
   filter, MVI record projection, minimal mutate envelope, budget enforcement,
   audit, idempotency and telemetry. The rate limiter, protocol enforcement and
   verification-gate middlewares in `packages/cleo/src/dispatch/middleware/`
   are not part of the CLI chain.
4. **Handle.** The domain handler (`packages/cleo/src/dispatch/domains/`) calls
   its engine (`packages/cleo/src/dispatch/engines/`), which calls the
   business logic in `@cleocode/core`.
5. **Store.** Core reads and writes the project or global `cleo.db` through
   `openDualScopeDb` and the store accessors.
6. **Respond.** The result returns as one LAFS envelope on stdout (ADR-086);
   logs go to stderr.

`tasks.update` with `status=done` goes through the same completion checks as
`tasks.complete`.

## Where documents go

Canonical docs are written through the docs store, never with a raw file write
(ADR-076). `.cleo/canon.yml` routes each kind to its mirror folder, one kind
per folder: `docs/adr/`, `docs/spec/`, `docs/guide/`, `docs/concept/`,
`docs/reference/`, `docs/plan/`, `docs/research/`, `docs/note/`,
`docs/release/` and the others. Handoffs are store-only and never published.
RCASD stage output publishes under `.cleo/rcasd/`; the `.cleo/` layout is in
the [scaffolding spec](../spec/cleo-scaffolding-ssot.md) (ADR-045).

Names follow one rule (T14107, D11210): lowercase kebab-case, at most 64
characters, with no task id, session id or date. Task and decision links live
in the doc's metadata. The how-to is the
[documentation SOP](../guide/cleo-documentation-sop.md).

## Package map

| Package | Role |
|---|---|
| `packages/core/` | The SDK: domain logic, store, memory, lifecycle, docs, release |
| `packages/cleo/` | The CLI: thin dispatch and command handlers only |
| `packages/contracts/` | Shared types: envelope, operations, errors |
| `packages/runtime/` | The dispatch gateway behind the CLI; its long-running services are slated for removal (ADR-098) |
| `packages/paths/` | Platform paths, project hash and the worktree root |
| `packages/worktree/` | The worktree backend |
| `packages/nexus/` | Project registry and code intelligence |
| `packages/caamp/`, `packages/adapters/` | Provider registry and per-harness delivery |
| `packages/cant/` | The `.cant` parser and validator |
| `packages/lafs/` | The envelope spec and validator |
| `packages/skills/` | The bundled `ct-*` skills |
| `packages/studio/` | The web portal for tasks, memory and the graph |
| `packages/cleo-os/` | Retired Pi harness, frozen for removal (ADR-098) |

The package boundary rules are in `AGENTS.md`.

## References

- [CLEO canon index](cleo-canon-index.md): read order and map of the canonical docs
- ADR-098, harness-agnostic core: `cleo docs fetch adr-098-retire-the-pi-cleoos-harness`
- [ADR-097: CLEO Goal](../adr/ADR-097-goal-protocol-ocg-runtime.md)
- [ADR-076: canonical docs SSoT](../adr/ADR-076-canonical-docs-ssot.md)
- [Operation constitution](../spec/cleo-operation-constitution.md): domain and operation definitions
- [Verb standards](../spec/verb-standards.md): canonical verbs
- [Core SDK](../reference/core-sdk.md): the `@cleocode/core` API
- [Orchestration flow](orchestration-flow.md): spawn layers, lead and worker roles
