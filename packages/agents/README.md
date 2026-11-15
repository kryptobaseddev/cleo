# @cleocode/agents

> Part of [CLEO](https://github.com/kryptobaseddev/cleo#readme). Start with the root README; run `cleo <command> --help` for any command.

The universal subagent protocol, canonical lead and worker definitions, worker
templates, and meta-agents for CLEO.

## Scope (ADR-068)

Per [ADR-068](../../docs/adr/adr-068-canonical-agent-system.md), this package
ships four surfaces (the `files` list in `package.json`):

1. **`cleo-subagent.cant`**: the universal protocol base, and the last tier of
   the agent resolver.
2. **`definitions/`**: the canonical `cleo-lead` and `cleo-worker` agents that
   `cleo init` and `cleo upgrade` render into each detected provider's
   project agent files (T14378).
3. **`templates/`**: five project worker templates with `{{variable}}`
   placeholders. Each filename basename equals its declared `agent <name>:`.
4. **`meta/`**: meta-agents that synthesize other agents and playbooks from
   project context.

The cleocode repository's own dogfood personas (`cleo-prime`, `cleo-dev`,
`cleo-historian`, `cleo-rust-lead`, `cleo-db-lead`) live in
`.cleo/cant/agents/` in that repository and are not shipped to users.

## Package Tree

```
packages/agents/
├── package.json
├── README.md                                 # this file
├── cleo-subagent.cant                        # universal protocol base
├── definitions/
│   ├── cleo-lead.cant                        # plans and dispatches; no shell, no edits
│   └── cleo-worker.cant                      # executes one task, returns a short report
├── templates/
│   ├── README.md
│   ├── project-orchestrator.cant             # coordinates the starter team
│   ├── project-dev-lead.cant                 # decides HOW, reviews workers
│   ├── project-code-worker.cant              # writes code within globs
│   ├── project-docs-worker.cant              # writes/edits documentation
│   └── project-security-worker.cant          # security review and audits
├── meta/
│   ├── README.md
│   ├── agent-architect.cant                  # meta-agent: synthesizes agents
│   └── playbook-architect.cant               # meta-agent: synthesizes playbooks
└── tests/
    └── templates.test.ts
```

## The Universal Protocol Base: `cleo-subagent.cant`

`cleo-subagent.cant` declares the `cleo-subagent` agent (role `subagent`,
skills `ct-cleo` and `ct-task-executor`). It defines:

- **RFC 2119 constraints**: output rules OUT-001…OUT-004 (write findings to the
  output path, append a manifest entry before returning, return a summary
  only) and BASE-001…BASE-008 (one manifest entry, no content in responses,
  complete the task, output file before manifest entry, start the task before
  work, no fabrication, link memory observations to the task, check `success`
  on every LAFS response).
- **Tool, domain and permission declarations**, plus required, optional and
  computed tokens (`TASK_ID`, `DATE`, `TOPIC_SLUG`, `OUTPUT_PATH`, …).
- **Anti-patterns** with their fixes, and `SessionStart` / `PostToolUse` hooks.

## Canonical Lead and Worker (`definitions/`)

`cleo init` and `cleo upgrade` call `ensureAgentDefinitions`
(`packages/core/src/agents/ensure-agent-definitions.ts`), which renders these
files through CAAMP into every detected provider that loads project agent
files (for example `.claude/agents/cleo-lead.md`). A file without CAAMP's
generated marker belongs to the user and is never overwritten.

| Definition | Role | Purpose |
|------------|------|---------|
| `cleo-lead.cant` | lead | Talks to the owner and dispatches `cleo-worker` agents. Denied Bash/Edit/Write/web tools; runs allow-listed `cleo`/`gh` argv through the lead runner MCP tool. Not installed for OpenCode, whose agent files cannot hold a tool allow-list. |
| `cleo-worker.cant` | worker | Owns one CLEO task end to end, runs in the background, and returns a three-line report (conclusion, blocker, proof). |

## Worker Templates (`templates/`)

The five templates are parameterized blueprints with `{{variable}}`
placeholders. They stay project-agnostic: no CLEO-internal references and no
tool-chain assumptions beyond what each template parameterizes.

| Template | Role | Purpose |
|----------|------|---------|
| `project-orchestrator.cant` | orchestrator | Reads task context, classifies work, dispatches to the dev-lead, synthesizes results. Does not execute code. |
| `project-dev-lead.cant` | lead | Decomposes work, reviews output, decides technical direction. Must not hold Edit/Write/Bash (TEAM-002). |
| `project-code-worker.cant` | worker | Writes code within declared globs; runs `{{build_command}}` and `{{test_command}}`. |
| `project-docs-worker.cant` | worker | Writes documentation within documentation globs. |
| `project-security-worker.cant` | worker | Security review, OWASP threat modelling, dependency audits. Read-only; escalates findings. |

Together they form a starter team: one orchestrator, one lead and three
workers. For richer topologies, the `agent-architect` meta-agent synthesizes
additional personas.

### Naming Contract (ADR-068 Decision 1)

Every `.cant` filename basename MUST equal the `agent <name>:` declaration
inside it. Templates use the `project-<role>` prefix to match the classifier
output (`packages/core/src/orchestration/classify.ts`). The install pipeline
(`packages/core/src/store/agent-install.ts`) enforces this.

## How Variables Work

Templates use mustache `{{var}}` syntax, per
[ADR-055](../../docs/adr/adr-055-agents-architecture-and-meta-agents.md).
The engine is `packages/core/src/agents/variable-substitution.ts`.

### Syntax

- `{{name}}`: simple variable
- `{{object.key}}`: dot-notation into the project context
- `{{inputs.taskId}}`: already used in `.cantbook` playbooks

Resolved values are never re-scanned, so a value containing `{{...}}` stays
literal.

### Resolution Order

Each placeholder resolves from the first source that has it:

1. **Bindings**: a flat key map supplied by the caller.
2. **Session context**: at spawn time `taskId`, `sessionId`, `protocol`,
   `agentId`, `role`, `tier`, `harnessHint` (and `spawnTaskId`).
3. **Project context**: `.cleo/project-context.json`, read with dot-notation.
4. **Environment**: `CLEO_<NAME>` then `CANT_<NAME>` (name upper-cased, dots
   become underscores).
5. **Default**: `SubstitutionOptions.defaultValue`, when set.
6. **Missing**: lenient mode leaves the placeholder and reports it; strict mode
   returns the text unchanged with `success: false`.

### Spawn-Time Resolution

`cleo init` copies templates with their placeholders intact. At spawn,
`orchestrateSpawnExecute` (`packages/core/src/orchestrate/spawn-ops.ts`) reads
the resolved agent's `.cant` body and substitutes it in lenient mode after
`composeSpawnPayload` resolves the agent and before the adapter receives the
prompt. Missing variables are reported under `data.meta.templateSubstitution`.
So the same template can spawn differently per task, and project-context
changes apply on the next spawn without reinstalling.

## Auto-Registration on `cleo init`

Per ADR-068 Decision 3, plain `cleo init` walks `@cleocode/agents/templates/`
and calls `installAgentFromCant()` for each `.cant` template
(`installTemplatesAtProjectTier` in `packages/core/src/init.ts`). Each install
copies the file to `<project>/.cleo/cant/agents/` and writes an
`agent_registry_agents` row with `tier='project'` in the **global** `cleo.db`
(schema: `packages/core/src/store/schema/cleo-global/agent-registry.ts`).
Re-running init overwrites stale rows instead of duplicating them.

`--install-seed-agents` is a deprecated no-op: init emits a
`W_DEPRECATED_AGENT_PATH` warning when it is passed.

## Authoring a New Agent

### 1. Start from a template or from `cleo-subagent.cant`

```bash
cp packages/agents/templates/project-code-worker.cant \
   my-project/.cleo/cant/agents/my-worker.cant
```

Rename the agent (the filename must match), tune the description, skills and
tools, and either replace `{{variable}}` placeholders with literal values or
leave them for spawn-time resolution. `cleo agent create --name <n> --role <r>`
scaffolds a new agent package instead.

### 2. Validate the CANT syntax

```bash
cleo cant validate my-project/.cleo/cant/agents/my-worker.cant
```

### 3. Install into the registry

```bash
cleo agent install my-project/.cleo/cant/agents/my-worker.cant
```

### 4. Check registry drift

```bash
cleo agent doctor --json
```

## Tier Precedence (Resolver Chain)

`resolveAgent` (`packages/core/src/store/agent-resolver.ts`) walks five tiers
in order. Tiers 1–3 are `agent_registry_agents` rows with that `tier` value
whose `cant_path` still exists on disk; an orphan row is skipped, not fatal.

1. **project**: rows attached from `<project>/.cleo/cant/agents/`
2. **global**: rows installed from the global agents directory
3. **packaged**: rows installed from `@cleocode/agents/templates/`
4. **fallback**: no row, but `templates/<agentId>.cant` exists on disk
5. **universal**: an envelope synthesized from `cleo-subagent.cant`
   (ADR-068 Decision 6)

`E_AGENT_NOT_FOUND` is thrown only when every tier misses, which means
`cleo-subagent.cant` itself is unreachable.

**Global directory caveat (T14588):** `cleo agent create --global` and the
seed installer use `<cleoHome>/cant/agents/`, but
`cleo agent install --global` writes to `<cleoHome>/agents/`
(`getCleoGlobalAgentsDir`). `<cleoHome>` is `~/.local/share/cleo` on Linux and
`~/Library/Application Support/cleo` on macOS.

## Contract Guarantees

- **Atomic install**: `installAgentFromCant` copies the `.cant` file, upserts
  the `agent_registry_agents` row and rewrites its
  `agent_registry_agent_skills` junctions in one `BEGIN IMMEDIATE`
  transaction. An existing row without `force` fails with
  `E_AGENT_ALREADY_INSTALLED`.
- **Idempotent seed install**: `packages/core/src/agents/seed-install.ts`
  compares `<cleoHome>/.seed-version` against the bundled version and returns
  early when they match.
- **Doctor drift reporting**: `packages/core/src/store/agent-doctor.ts` emits
  D-001…D-010 (orphan file, orphan row, SHA mismatch, unattached global,
  missing or extra skills, parse error, legacy path, deprecated agent still
  live, legacy JSON registry). `cleo agent doctor --repair` applies the safe
  repairs (D-002 orphan-row delete, D-003 hash refresh).

## See Also

- [ADR-055: Agents Architecture + Meta-Agents](../../docs/adr/adr-055-agents-architecture-and-meta-agents.md) (partially superseded by ADR-068)
- [ADR-068: Canonical Agent System](../../docs/adr/adr-068-canonical-agent-system.md)
- [Package boundary contract](../../AGENTS.md): layering for every CLEO package
- [Meta-agents guide](../../docs/guide/meta-agents.md): authoring meta-agents

## License

MIT. See [LICENSE](../../LICENSE).
