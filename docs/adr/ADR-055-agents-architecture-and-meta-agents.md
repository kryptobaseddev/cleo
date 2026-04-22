# ADR-055: Agents Architecture + Meta-Agents

**Status**: Accepted (2026-04-22)
**Date**: 2026-04-22
**Task**: T1240 (epic T1232 — CLEO Agents Architecture Remediation for v2026.4.110)
**Scope**: `packages/agents/`, `packages/core/src/agents/`, `packages/core/src/paths.ts`, `packages/cant/src/native-loader.ts`, `.cleo/cant/agents/`
**Supersedes (prose)**: D022 (seed-agents ship raw), D025 (packaged-tier resolver mandate), D026 (static seed-install copy)
**Superseded-By**: none

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT",
"RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in
RFC 2119.

---

## Context

Prior to v2026.4.110, `packages/agents/` shipped **six cleocode-specific personas**
(cleo-prime, cleo-dev, cleo-historian, cleo-rust-lead, cleo-db-lead, cleoos-opus-orchestrator)
under `packages/agents/seed-agents/` as "starter agents". Audit R3
(`/mnt/projects/cleocode/.cleo/agent-outputs/T-AGENTS-PRE-WAVE/R3-CONTENT-AUDIT.md`)
established that these personas reference CleoCode-internal crates, SignalDock APIs,
and CLEO canon. Installing them into a new user's project by default polluted that
project's identity space with the CLEO team's dogfood personas and produced immediate
dissonance ("Why is `cleo-rust-lead` talking about `cant-core` in my unrelated Rust
project?").

The four research artifacts for epic T1232 documented the root cause and the
corrective architecture:

- **R1** (`R1-AGENT-ARCHITECTURE-AUDIT.md`) — traced the 4-tier resolver
  (project → global → packaged → fallback), the T897 v3 schema, the atomic install
  transaction, and the D-001…D-010 doctor drift codes. Verdict: the resolver,
  installer, doctor, and seed-installer are sound; only the **contents** shipped in
  `seed-agents/` are wrong.
- **R2** (`R2-VARIABLE-SYNTAX-DESIGN.md`) — specified the template substitution
  engine (mustache `{{var}}`, resolver chain bindings → session → project-context
  → env → default, lazy at `cleo orchestrate spawn`). Mustache `{{...}}` already
  appears literally in starter `.cantbook` files (`release`, `rcasd`, `ivtr`) — the
  playbook runtime preserved these as opaque strings pending a resolver, which R2
  now supplies.
- **R3** (`R3-CONTENT-AUDIT.md`) — classified every file under the four agent
  locations (`packages/agents/seed-agents/`, `packages/agents/cleo-subagent/`,
  `.cleo/cant/agents/`, `.cleo/agents/`) and produced the migration matrix. Four
  genuinely-generic templates (orchestrator, dev-lead, code-worker, docs-worker)
  already live in `.cleo/cant/agents/` and are the correct ship surface.
- **R4** (`R4-META-AGENT-DESIGN.md`) — defined the meta-agent concept
  (compositional agents whose output is other agents), drafted the
  `agent-architect.cant` meta-agent as the first implementation, and proved via
  playbook parser inspection that agentic nodes can invoke meta-agents with
  **zero** parser or schema changes.

Three operational decisions were filed during the pre-wave session (D029 env-paths
worktree canon, D030 native worktree) and are in scope of T1232 but are adjacent
to the agent-package remediation proper; this ADR captures the four decisions
(D031–D034) that govern the agents architecture directly.

## Decisions

### D031 — cleocode-specific personas relocate to `.cleo/cant/agents/`; NOT shipped

The six personas classified by R3 as `CLEO-PROJECT-SPECIFIC` (cleo-prime, cleo-dev,
cleo-historian, cleo-rust-lead, cleo-db-lead, cleoos-opus-orchestrator) MUST NOT
ship in the `@cleocode/agents` npm package. They are CLEO team dogfood personas,
not user-facing templates.

**Destination**: `.cleo/cant/agents/` (project-tier, per T897/T899 canonical path).
The legacy `.cleo/agents/` companion bootstrap `.md` files stay in place as
MVI-tiered companions for local CLEO work.

**Implication for the seed installer**: `ensureSeedAgentsInstalled()` no longer
copies these six personas anywhere. The global tier
(`~/.local/share/cleo/cant/agents/`) receives only the four generic templates from
D032.

**Migration impact**: deletion of the legacy `.cleo/agents/` flat layout in favor
of `.cleo/cant/agents/` closes doctor diagnostic D-008 (`legacy-path`).

### D032 — `packages/agents/` ships universal protocol base + 4 generic templates + meta-agents

The `@cleocode/agents` package surface area for v2026.4.110 is exactly:

```
packages/agents/
├── package.json
├── README.md
├── cleo-subagent.cant                 # universal protocol base, promoted from seed-agents/
├── seed-agents/
│   ├── README.md
│   ├── orchestrator-generic.cant      # from .cleo/cant/agents/cleo-orchestrator.cant
│   ├── dev-lead-generic.cant          # from .cleo/cant/agents/dev-lead.cant
│   ├── code-worker-generic.cant       # from .cleo/cant/agents/code-worker.cant
│   └── docs-worker-generic.cant       # from .cleo/cant/agents/docs-worker.cant
├── meta/
│   ├── README.md
│   └── agent-architect.cant           # first meta-agent; synthesizes project agents
└── harness-adapters/                  # OPTIONAL; ships if present
    └── claude-code/
        └── cleo-subagent.AGENT.md
```

**cleo-subagent.cant** MUST be promoted to the package root (flattening the
`cleo-subagent/` subdirectory) so it is the universal base protocol that every
other agent in the ecosystem extends. The matching Claude Code harness adapter
moves under `harness-adapters/claude-code/` to make room for future
`harness-adapters/openai/`, `harness-adapters/cursor/`, etc.

**The four seed templates** MUST contain only `{{var}}` placeholders and generic
prose; no CLEO-internal references, no SignalDock mentions, no cleocode crate
names. R3's §"Drafted Template Bodies" gives the canonical template bodies.

**The meta-agents directory** MUST be declared in `package.json#files` so it
ships in the npm tarball and can be resolved by the seed-install flow.

### D033 — Variable substitution = mustache `{{var}}` with dot-notation, lazy at spawn-time

Per R2, the canonical CLEO template variable syntax is mustache-style double
braces: `{{tech_stack}}`, `{{conventions.typeSystem}}`, `{{inputs.targetVersion}}`.

The resolver chain, in priority order:

1. Explicit bindings (highest — passed at spawn time from the task context)
2. Session context (`playbook_runs.bindings`, task + epic identifiers, user)
3. Project context (`.cleo/project-context.json`, traversed via dot-notation)
4. Environment variables (with `CLEO_` or `CANT_` prefix, uppercase)
5. Default value from the `SubstitutionOptions` (when provided)
6. Missing — strict mode throws; non-strict leaves `{{var}}` literal in output

Substitution MUST be **lazy**: templates install to disk with `{{...}}` intact and
are resolved only at `cleo orchestrate spawn` time inside the spawn-payload
composition path. This preserves BRAIN-integration flexibility (dynamic context
from `composeSpawnPayload` can feed into the resolver), allows the same template
to spawn differently under different bindings, and avoids re-running install when
project context changes.

See R2 §4 for the `VariableResolver` interface, §5 for the worked example, §6 for
the three canonical test vectors, and §7 for the integration point in
`orchestrateSpawnExecute`.

Escaping, recursion, filters, and partial-include syntax are explicitly **out of
scope** for v2026.4.110 (R2 §11). The mustache surface is extensible without
breaking change; those features MAY be added in a later release.

### D034 — Meta-agent concept + `agent-architect` as first implementation

A **meta-agent** is an agent whose output is another agent. It ingests project
context, seed templates, and configuration; it emits customized `.cant` files
written directly to `.cleo/cant/agents/`. Meta-agents differ from subagents in
lifecycle (compositional, run during bootstrap) and purpose (produce artifacts,
not perform work). R4 §1 gives the canonical definition.

**`agent-architect`** is the first meta-agent and ships at
`packages/agents/meta/agent-architect.cant`. R4 §2 gives the complete canonical
definition. Its contract:

- **Inputs**: `.cleo/project-context.json`, seed templates under
  `packages/agents/seed-agents/`, configuration payload (model, tier, skills,
  domains).
- **Output**: customized `.cant` files written to `.cleo/cant/agents/`, one
  `agent-created: {filename}.cant` line per file on stdout, and one
  `pipeline.manifest` entry per generated agent.
- **Invocation**: `cleo init --install-seed-agents` delegates to this meta-agent
  instead of performing a static copy. R4 §4 documents the redesigned flow.

**Playbook integration**: R4 §3 verified by parser-level evidence that meta-agents
are invocable from any `.cantbook` agentic node via `agent: agent-architect`. No
schema change is required; the `PlaybookAgenticNode` contract already permits
agent identifiers at arbitrary tiers. R4 §6 gives a canonical
`installation.cantbook` fragment.

**Meta-agent roster** (future; §5 of R4): `skill-architect`,
`playbook-architect`, `manifest-architect`. These are stubs scheduled for future
waves; only `agent-architect` ships in v2026.4.110.

## Rationale

Three forces drove the shape of these four decisions:

1. **Correctness over legacy inertia.** The existing `packages/agents/seed-agents/`
   contents were architecturally wrong (project-specific personas shipped as
   starter templates) even though the seed-install machinery was architecturally
   correct (atomic copy, version marker, idempotent). Preserving the right
   machinery while replacing the wrong contents is cheaper than rewriting the
   installer.
2. **Uniform variable substitution across CANT and playbooks.** Playbooks already
   carried `{{inputs.*}}` as literal strings because the runtime had no resolver.
   Agent templates need the same capability. Unifying on mustache syntax lets
   one resolver serve both surfaces and matches the syntax already in the wild
   (R2 §2). Lazy resolution preserves the composer/BRAIN integration.
3. **Bootstrap-as-dialogue, not bootstrap-as-copy.** A meta-agent that reasons
   about the host project before emitting agents produces a better starter
   experience than a static `cp -r` of anonymized templates. The runtime cost is
   one-time at init; the quality gain is permanent.

## Consequences

**Positive**:

- New users get four *truly* generic templates plus an AI that customizes them to
  the project at hand. No more CLEO-internal persona pollution.
- One substitution grammar covers agents and playbooks; one resolver (R2) covers
  both surfaces.
- Meta-agents become a category of agent; `agent-architect` is the proof of
  concept for `skill-architect`, `playbook-architect`, etc.
- The legacy `.cleo/agents/` flat layout is fully deprecated; `.cleo/cant/agents/`
  becomes the singular canonical path for project-tier agents (reinforcing T889,
  T897, T899 decisions).

**Negative**:

- `cleo init --install-seed-agents` acquires an LLM-synthesis dependency in its
  happy path. The fallback copy of seed templates preserves offline behavior, but
  first-class bootstrap now consumes LLM budget.
- Three docs/adrs moved by prose (D022/D025/D026) — implementers relying on the
  older "starter agents are shipped-verbatim" assumption need the CHANGELOG +
  README cue to find this document.
- The harness-adapters surface is new; until a second harness ships, the
  directory has one entry. This is intentional structural scaffolding and MUST
  NOT be treated as premature abstraction to be collapsed.

**Neutral**:

- Schema, resolver, installer, and doctor code in `packages/core/src/agents/` and
  `packages/core/src/store/` remains sound. Only seed-install and the composer
  spawn path gain new integration points (per R2 §7 and R4 §4).

## Implementation Notes

Implementation waves for this ADR land across epic T1232:

- **T1234 (R2)** — implement `VariableResolver` at `packages/cant/src/variable-resolver.ts`,
  unit tests for the three R2 test vectors, wire into
  `orchestrateSpawnExecute`.
- **T1235 (R3)** — delete six cleocode-specific personas from `seed-agents/`,
  copy the four generic templates with `-generic.cant` suffix, move
  `cleo-subagent.cant` to package root, relocate harness adapter.
- **T1236 (R4)** — create `packages/agents/meta/agent-architect.cant`, redesign
  `ensureSeedAgentsInstalled()` to invoke it via the orchestrator dispatcher,
  preserve static-copy fallback.
- **T1240 (I4)** — this ADR, `packages/agents/README.md` rewrite,
  `docs/meta-agents.md` developer guide, `CHANGELOG.md` v2026.4.110 entry.

R1's Recommendations 2–6 (native-loader validation, skill-parser consolidation,
project-tier path-traversal check, D-008 auto-repair, `agent tier-list` CLI,
seed-version health check) remain scoped to T1232 but are tracked as separate
child tasks.

## References

- **R1 — Agent Architecture Audit**: `/mnt/projects/cleocode/.cleo/agent-outputs/T-AGENTS-PRE-WAVE/R1-AGENT-ARCHITECTURE-AUDIT.md`
- **R2 — Variable Syntax Design**: `/mnt/projects/cleocode/.cleo/agent-outputs/T-AGENTS-PRE-WAVE/R2-VARIABLE-SYNTAX-DESIGN.md`
- **R3 — Content Audit**: `/mnt/projects/cleocode/.cleo/agent-outputs/T-AGENTS-PRE-WAVE/R3-CONTENT-AUDIT.md`
- **R4 — Meta-Agent Design**: `/mnt/projects/cleocode/.cleo/agent-outputs/T-AGENTS-PRE-WAVE/R4-META-AGENT-DESIGN.md`
- **Prior art**: T889 (agent path migration to `.cleo/cant/agents/`), T897
  (agent registry v3 schema), T899 (tier precedence canon)
- **Related**: ADR-052 (SDK consolidation), ADR-053 (playbook runtime state machine),
  ADR-054 (migration system hybrid path A+)
- **Package boundary**: `packages/agents/` ships universal + template content;
  `packages/core/src/agents/` owns resolver, installer, doctor; `packages/cant/`
  owns the variable-resolver implementation (R2 §12)

---

**End of ADR-055**
