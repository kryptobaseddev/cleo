# @cleocode/agents

Universal subagent protocol, generic starter templates, and meta-agents for the
CLEO ecosystem.

## Scope (v2026.4.110 and later)

Per [ADR-055](../../docs/adr/ADR-055-agents-architecture-and-meta-agents.md), this
package ships exactly three surfaces:

1. **`cleo-subagent.cant`** — the universal protocol base every agent extends.
2. **`seed-agents/`** — four generic role templates with `{{variable}}`
   placeholders.
3. **`meta/`** — meta-agents that synthesize other agents from project context.

The package also ships **harness adapters** (`harness-adapters/claude-code/…`)
when a second harness surface is present. CleoCode-team dogfood personas (the
former `cleo-prime`, `cleo-dev`, `cleo-historian`, `cleo-rust-lead`,
`cleo-db-lead`, `cleoos-opus-orchestrator`) moved to `.cleo/cant/agents/` in the
cleocode repository and are NOT shipped to users.

## Package Tree

```
packages/agents/
├── package.json
├── README.md                                 # this file
├── cleo-subagent.cant                        # universal protocol base
├── seed-agents/
│   ├── README.md
│   ├── orchestrator-generic.cant             # coordinates the starter team
│   ├── dev-lead-generic.cant                 # decides HOW, reviews workers
│   ├── code-worker-generic.cant              # writes code within globs
│   └── docs-worker-generic.cant              # writes/edits documentation
├── meta/
│   ├── README.md
│   └── agent-architect.cant                  # meta-agent: synthesizes agents
└── harness-adapters/
    └── claude-code/
        └── cleo-subagent.AGENT.md            # Claude Code adapter for subagent base
```

## The Universal Protocol Base: `cleo-subagent.cant`

Every CLEO agent extends `cleo-subagent.cant`. It defines:

- **RFC 2119 constraints** (BASE-001…BASE-007) — manifest append, no content in
  responses, `cleo complete` as the terminal, output-before-manifest ordering,
  focus before work, no fabrication, research linking.
- **LOOM lifecycle** — Spawn → Execute → Output → Return, with explicit
  stage-specific guidance injected at spawn time.
- **Return format contract** — three allowed response strings, everything else
  goes to files and the manifest.
- **Error handling** — status classification, retryable exit codes, staleness
  and evidence rules (ADR-051).

The matching harness adapter (`harness-adapters/claude-code/cleo-subagent.AGENT.md`)
translates the protocol into Claude Code's `AGENT.md` frontmatter format. New
harnesses (OpenAI, Cursor, Codex, etc.) get sibling directories under
`harness-adapters/`.

## Generic Starter Templates

The four seed templates are parameterized blueprints with `{{variable}}`
placeholders. They MUST remain project-agnostic — no CLEO-internal references,
no tool-chain assumptions beyond what the template explicitly parameterizes.

| Template | Role | Purpose |
|----------|------|---------|
| `orchestrator-generic.cant` | orchestrator | Reads tasks, routes to the dev-lead, synthesizes results. Does not execute code. |
| `dev-lead-generic.cant` | lead | Decomposes work, reviews output, decides technical direction. Dispatch-only authority; no Edit/Write/Bash. |
| `code-worker-generic.cant` | worker | Writes code within declared globs. Runs `{{test_command}}` and `{{build_command}}`. Holds Edit/Write/Bash. |
| `docs-worker-generic.cant` | worker | Writes documentation (README, TSDoc, guides) within doc globs. Holds Edit/Write/Bash scoped to docs. |

These four make a complete starter team: one orchestrator + one lead + two
workers. For projects that need richer topologies, the `agent-architect`
meta-agent (see below) synthesizes additional personas.

## How Variables Work

CLEO uses mustache `{{var}}` syntax for template substitution, per
[ADR-055 D033](../../docs/adr/ADR-055-agents-architecture-and-meta-agents.md).

### Syntax

- `{{name}}` — simple variable
- `{{object.key}}` — dot-notation for nested values
- `{{inputs.taskId}}` — already used in starter `.cantbook` playbooks

### Resolver Chain

Variables resolve in priority order at **spawn time** (not install time):

1. **Explicit bindings** — highest priority; passed programmatically from the
   task or orchestrator.
2. **Session context** — `playbook_runs.bindings`, task + epic identifiers, user.
3. **Project context** — `.cleo/project-context.json`, traversed via
   dot-notation (e.g., `{{conventions.typeSystem}}` reads
   `conventions.typeSystem` from project-context.json).
4. **Environment variables** — `CLEO_*` or `CANT_*` prefix, uppercase name
   (`{{tech_stack}}` tries `CLEO_TECH_STACK` then `CANT_TECH_STACK`).
5. **Default value** — when `SubstitutionOptions.defaultValue` is set.
6. **Missing** — strict mode throws `E_TEMPLATE_RESOLUTION`; non-strict leaves
   `{{var}}` literal in the rendered output.

### Why Lazy (Spawn-Time)?

Templates install with `{{...}}` placeholders intact. Resolution happens inside
`orchestrateSpawnExecute` right before `composeSpawnPayload`, which means:

- The same template can spawn differently under different bindings.
- BRAIN-provided context (mental-model slices, memory queries) can feed the
  resolver.
- Project context changes (e.g., bumping `testing.framework`) are picked up on
  the next spawn without reinstalling.

Full specification lives in R2 (`R2-VARIABLE-SYNTAX-DESIGN.md`). The resolver
implementation ships in `packages/cant/src/variable-resolver.ts`.

## Authoring a New Agent

### 1. Start from a template or from `cleo-subagent.cant`

```bash
cp packages/agents/seed-agents/code-worker-generic.cant \
   my-project/.cleo/cant/agents/my-worker.cant
```

Edit the agent name, tune the description + skills + tool list, replace
`{{variable}}` placeholders with either literal values (if project-specific) or
leave them for lazy resolution at spawn time.

### 2. Validate the CANT syntax

```bash
cleo cant validate my-project/.cleo/cant/agents/my-worker.cant
```

The validator enforces the 42-rule engine (kind/version, required frontmatter,
role/parent coherence, skill references, permission globs).

### 3. Install into the registry

```bash
cleo agent install my-project/.cleo/cant/agents/my-worker.cant
```

This atomically copies the file to the canonical project-tier path
(`.cleo/cant/agents/my-worker.cant`), writes the `agents` registry row, and
populates the `agent_skills` junction. Use `--global` for
`~/.local/share/cleo/cant/agents/`.

### 4. Verify resolver coverage

```bash
cleo agent doctor --json
```

Checks D-001 (orphan files) through D-010 (legacy JSON imports). Resolves D-002
(orphan rows) and D-003 (sha-mismatch) by default; opt into D-008 path
migration or legacy-JSON import with flags.

## Installing Agents

CLEO installs agents in two places:

- **Global** — `~/.local/share/cleo/cant/agents/` via `cleo agent install --global`
  or `cleo init --install-seed-agents`.
- **Project** — `{projectRoot}/.cleo/cant/agents/` via `cleo agent install`
  (default).

### Static install (seed templates)

```bash
cleo init --install-seed-agents
```

Copies the four generic templates + `cleo-subagent.cant` into the global tier,
writes the `.seed-version` marker, and is idempotent on subsequent runs.

### Meta-agent-driven install (synthesized personas)

```bash
cleo init --install-seed-agents
```

Per [ADR-055 D034](../../docs/adr/ADR-055-agents-architecture-and-meta-agents.md),
the same command invokes `agent-architect` behind the scenes. The meta-agent:

1. Reads `.cleo/project-context.json`.
2. Loads the four generic templates from `packages/agents/seed-agents/`.
3. Synthesizes project-customized personas (e.g., `myproject-lead.cant`,
   `myproject-code-worker.cant`) in `.cleo/cant/agents/`.
4. Falls back to the static copy if the dispatcher is unavailable (offline, CI
   without LLM access, explicit `--skip-agent-synthesis`).

See `docs/meta-agents.md` for the full meta-agent developer guide and the
architect's contract.

## Tier Precedence (Resolver Chain)

Agent resolution at spawn time walks four tiers in order (per T899):

1. **project** — `{projectRoot}/.cleo/cant/agents/{agentId}.cant`
2. **global** — `~/.local/share/cleo/cant/agents/{agentId}.cant`
3. **packaged** — `packages/agents/seed-agents/{agentId}.cant` (the files this
   package ships)
4. **fallback** — seed file on disk with no registry row, synthesized envelope
   with `canSpawn=false`

The `DEPRECATED_ALIASES` table (readonly, frozen) transparently rewrites old
IDs before the tier walk — it currently contains
`cleoos-opus-orchestrator → cleo-prime` (T889 identity consolidation).

## Contract Guarantees

- **Atomic install** — `packages/core/src/store/agent-install.ts` wraps the
  `.cant` copy, `agents` row upsert, and `agent_skills` junction rewrite in a
  single `BEGIN IMMEDIATE TRANSACTION`. On any failure the file is unlinked if
  this call created it and the DB rolls back.
- **Idempotent seed install** — `packages/core/src/agents/seed-install.ts`
  compares `.seed-version` against the bundled `package.json` version and
  returns early when they match.
- **Doctor drift reporting** — `packages/core/src/store/agent-doctor.ts` emits
  D-001…D-010 codes for orphan files, SHA mismatch, legacy paths, missing
  skills, and legacy JSON registries. Default reconcile repairs D-002 and D-003;
  all others are opt-in.

## See Also

- [ADR-055 — Agents Architecture + Meta-Agents](../../docs/adr/ADR-055-agents-architecture-and-meta-agents.md)
- [Meta-Agent Developer Guide](../../docs/meta-agents.md)
- [Package boundary contract](../../AGENTS.md) — canonical layering for every
  CLEO package
- R1–R4 research artifacts under `.cleo/agent-outputs/T-AGENTS-PRE-WAVE/`

## License

MIT — see [LICENSE](../../LICENSE).
