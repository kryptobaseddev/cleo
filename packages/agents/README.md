# @cleocode/agents

Universal subagent protocol, canonical worker templates, and meta-agents for the
CLEO ecosystem.

## Scope (ADR-068 — v2026.5.30 and later)

Per [ADR-068](.cleo/adrs/ADR-068-canonical-agent-system.md), this package ships
exactly three surfaces:

1. **`cleo-subagent.cant`** — the universal protocol base every agent extends.
2. **`templates/`** — five named worker templates with `{{variable}}` placeholders.
   Filename basename equals declared `agent <name>:` per the install-validator contract.
3. **`meta/`** — meta-agents that synthesize other agents from project context.

CleoCode-team dogfood personas (the former `cleo-prime`, `cleo-dev`,
`cleo-historian`, `cleo-rust-lead`, `cleo-db-lead`, `cleoos-opus-orchestrator`)
live in `.cleo/cant/agents/` in the cleocode repository and are NOT shipped to
users.

## Package Tree

```
packages/agents/
├── package.json
├── README.md                                 # this file
├── cleo-subagent.cant                        # universal protocol base
├── templates/
│   ├── project-orchestrator.cant             # coordinates the starter team
│   ├── project-dev-lead.cant                 # decides HOW, reviews workers
│   ├── project-code-worker.cant              # writes code within globs
│   ├── project-docs-worker.cant              # writes/edits documentation
│   └── project-security-worker.cant          # security review and audits
└── meta/
    ├── README.md
    ├── agent-architect.cant                  # meta-agent: synthesizes agents
    └── playbook-architect.cant               # meta-agent: synthesizes playbooks
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

## Canonical Worker Templates

The five worker templates are parameterized blueprints with `{{variable}}`
placeholders. They MUST remain project-agnostic — no CLEO-internal references,
no tool-chain assumptions beyond what the template explicitly parameterizes.

| Template | Role | Purpose |
|----------|------|---------|
| `project-orchestrator.cant` | orchestrator | Reads tasks, routes to the dev-lead, synthesizes results. Does not execute code. |
| `project-dev-lead.cant` | lead | Decomposes work, reviews output, decides technical direction. Dispatch-only authority; no Edit/Write/Bash (TEAM-002). |
| `project-code-worker.cant` | worker | Writes code within declared globs. Runs `{{test_command}}` and `{{build_command}}`. Holds Edit/Write/Bash. |
| `project-docs-worker.cant` | worker | Writes documentation (README, TSDoc, guides) within doc globs. Holds Edit/Write/Bash scoped to docs. |
| `project-security-worker.cant` | worker | Security review, OWASP threat modelling, dependency audits. Read-only — escalates findings. |

These five make a complete starter team: one orchestrator + one lead + three
workers. For projects that need richer topologies, the `agent-architect`
meta-agent (see below) synthesizes additional personas.

### Naming Contract (ADR-068 Decision 1)

Every `.cant` filename basename MUST equal the `agent <name>:` declaration inside
it. Templates use the `project-<role>` prefix to match the classifier output
(`packages/core/src/orchestration/classify.ts`). This is enforced by the install
validator at `packages/core/src/store/agent-install.ts`.

## How Variables Work

CLEO uses mustache `{{var}}` syntax for template substitution, per
[ADR-055 D033](../../docs/adr/ADR-055-agents-architecture-and-meta-agents.md).

### Syntax

- `{{name}}` — simple variable
- `{{object.key}}` — dot-notation for nested values
- `{{inputs.taskId}}` — already used in starter `.cantbook` playbooks

### Resolver Chain (ADR-068 Decision 5)

Variables resolve in priority order at **spawn time** (not install time):

1. **Step bindings** — highest priority; step-level `bindings:` shadow playbook bindings.
2. **Playbook bindings** — top-level `bindings:` field.
3. **Session context** — `playbook_runs.bindings`, task + epic identifiers, user.
4. **Project context** — `.cleo/project-context.json`, traversed via dot-notation.
5. **Environment variables** — `CLEO_*` or `CANT_*` prefix.
6. **Default value** — when `SubstitutionOptions.defaultValue` is set.
7. **Missing** — strict mode throws `E_TEMPLATE_RESOLUTION`.

### Why Lazy (Spawn-Time)?

Templates install with `{{...}}` placeholders intact. Resolution happens inside
`orchestrateSpawnExecute` right before `composeSpawnPayload`, which means:

- The same template can spawn differently under different bindings.
- BRAIN-provided context (mental-model slices, memory queries) can feed the
  resolver.
- Project context changes are picked up on the next spawn without reinstalling.

## Auto-Installation on `cleo init`

Per ADR-068 Decision 3, plain `cleo init` (no flags) automatically walks
`@cleocode/agents/templates/` and calls `installAgentFromCant()` for each of the
5 worker templates. Each template is registered in `signaldock.db.agents` with
`tier='project'`.

A fresh `cleo init` followed by `cleo orchestrate spawn` for any of the 5 worker
roles succeeds without `E_AGENT_NOT_FOUND`.

The `--install-seed-agents` flag is preserved as a deprecated no-op alias with
a deprecation notice.

## Authoring a New Agent

### 1. Start from a template or from `cleo-subagent.cant`

```bash
cp packages/agents/templates/project-code-worker.cant \
   my-project/.cleo/cant/agents/my-worker.cant
```

Edit the agent name, tune the description + skills + tool list, replace
`{{variable}}` placeholders with either literal values (if project-specific) or
leave them for lazy resolution at spawn time.

### 2. Validate the CANT syntax

```bash
cleo cant validate my-project/.cleo/cant/agents/my-worker.cant
```

### 3. Install into the registry

```bash
cleo agent install my-project/.cleo/cant/agents/my-worker.cant
```

### 4. Verify resolver coverage

```bash
cleo agent doctor --json
```

## Tier Precedence (Resolver Chain)

Agent resolution at spawn time walks tiers in order (ADR-055 / ADR-068):

1. **project** — `{projectRoot}/.cleo/cant/agents/{agentId}.cant`
2. **global** — `~/.local/share/cleo/cant/agents/{agentId}.cant`
3. **packaged** — `packages/agents/templates/{agentId}.cant`
4. **fallback** — seed file on disk with no registry row
5. **universal** — `cleo-subagent.cant` synthesized envelope (ADR-068 Decision 6)

`E_AGENT_NOT_FOUND` is only thrown when `cleo-subagent.cant` itself is
unreachable, indicating a corrupt installation.

## Contract Guarantees

- **Atomic install** — `packages/core/src/store/agent-install.ts` wraps the
  `.cant` copy, `agents` row upsert, and `agent_skills` junction rewrite in a
  single `BEGIN IMMEDIATE TRANSACTION`.
- **Idempotent seed install** — `packages/core/src/agents/seed-install.ts`
  compares `.seed-version` against the bundled `package.json` version and
  returns early when they match.
- **Doctor drift reporting** — `packages/core/src/store/agent-doctor.ts` emits
  D-001…D-010 codes for orphan files, SHA mismatch, legacy paths, missing
  skills, and legacy JSON registries.

## See Also

- [ADR-055 — Agents Architecture + Meta-Agents](../../docs/adr/ADR-055-agents-architecture-and-meta-agents.md) (partially superseded by ADR-068)
- [ADR-068 — Canonical Agent System](.cleo/adrs/ADR-068-canonical-agent-system.md) (active canonical reference)
- [Package boundary contract](../../AGENTS.md) — canonical layering for every CLEO package

## License

MIT — see [LICENSE](../../LICENSE).
