# ADR-044 — Canon Reconciliation: 6 Systems, 11 Domains, Moving Op Count, SSoT Hierarchy

**Status**: PROPOSED
**Date**: 2026-04-15
**Task**: T637 (Finalize canon reconciliation — drift fix + ADR-044)
**Parent Epic**: T636 (Canon Finalization + Orphan Triage + Harness Sovereignty — plan precious-cooking-moonbeam)
**Relates to**: ADR-042 (operation model rationalization), commit `f336395a` (docs: correct 6 systems + 11 domains + 248 ops across 19 files)

---

## Context

CLEO's canonical identity drifted across three authoritative sources through 2026-Q1. As of the 2026-04-14 architecture audit (v2026.4.43) and the follow-up reconciliation commit `f336395a` (v2026.4.44), the drift has been largely closed for the concept layer, but residual drift remains in design docs, specs, and some in-code comments. This ADR does three things:

1. **Locks the canonical identity**: 6 systems, 11 domains, a *moving* operation count, LAFS demoted from system to protocol.
2. **Establishes the SSoT hierarchy**: which document wins when sources disagree.
3. **Enumerates residual drift** so it can be triaged without being silently lost.

### Timeline of Drift

| Period | Canon claim | Reality |
|--------|-------------|---------|
| Until 2026-04-13 | 4 systems (BRAIN, LOOM, NEXUS, LAFS), 10 domains ("Circle of Ten") | 11 domains in `packages/cleo/src/dispatch/types.ts` (`intelligence` added in T565); registry growing |
| Owner correction (2026-04-13, memory `feedback_six_systems_not_four.md`) | 6 systems: TASKS, LOOM, BRAIN, NEXUS, CANT, CONDUIT — LAFS is envelope format | Canon docs still said 4 systems |
| v2026.4.43 architecture audit (2026-04-14) | — | 13-agent parallel audit confirmed: 4 vs 6 systems; 10 vs 11 domains; 224 vs 248 ops |
| v2026.4.44 reconciliation commit `f336395a` (2026-04-14) | 6 systems + 11 domains + 248 ops corrected across 19 files | Bulk canon aligned; residual drift in design/specs/comments discovered post-commit |
| This ADR (2026-04-15) | Formalizes the identity; pins SSoT order; flags residual drift | 258 ops now in registry (count is a living variable, not a target) |

---

## Decisions

### Decision 1: Six Systems (Immutable Taxonomy)

CLEO has **exactly six systems**. They do not change, merge, or get replaced:

| System | Role | Primary Store |
|--------|------|---------------|
| **TASKS** | Work tracking — hierarchy, dependencies, lifecycle, audit | `tasks.db` |
| **LOOM** | Logical Order of Operations Methodology — RCASD-IVTR+C lifecycle | `tasks.db` (pipelineManifest) |
| **BRAIN** | Memory & cognition — observations, decisions, patterns, learnings, knowledge graph | `brain.db` |
| **NEXUS** | Cross-project coordination + code intelligence | `nexus.db` (global) |
| **CANT** | Collaborative Agent Notation Tongue — message grammar, hook taxonomy, DSL | `cant-core` crate (SSoT) |
| **CONDUIT** | Agent-to-agent relay — 4-shell stack (Pi native → conduit.db → signaldock.io → planned broker) | `conduit.db` (project), `signaldock.db` (global) |

**LAFS is NOT a system.** LAFS is the envelope format — a cross-cutting protocol contract that every operation response conforms to. It lives at the protocol layer alongside the SignalDock transport.

### Decision 2: Eleven Canonical Domains

The runtime contract defines **exactly eleven canonical domains** (the "Circle of Eleven"). They are the rooms in the workshop where operations live:

`tasks`, `session`, `memory`, `check`, `pipeline`, `orchestrate`, `tools`, `admin`, `nexus`, `sticky`, `intelligence`

The `intelligence` domain was added in T565 (predictive quality analysis). It has 5 query-only operations reading from brain.db and tasks.db.

The `CANONICAL_DOMAINS` array in `packages/cleo/src/dispatch/types.ts` is the machine-readable SSoT. This ADR is derived from that array.

### Decision 3: Operation Count is a Living Variable

The registry's total operation count has moved multiple times through 2026-Q2 (229 → 248 → 253 → 258 → …). **The count is not a target**. Canon documents MUST:

- Refer to `packages/cleo/src/dispatch/registry.ts` as the authoritative source
- Not hard-code a specific count in claims that must stay current
- Any stated count MUST be marked as "as of `<version>` / `<date>`" to set reader expectations

Future drift on this metric is expected and not itself a drift incident. The drift incident to prevent is when canon *misstates* the structure (domain list, system list, taxonomy) — not when it's rounded to a stale count.

### Decision 4: SSoT Hierarchy (Which Source Wins)

When sources disagree, resolve in this order. The *higher* entry wins:

1. **Code** (`packages/cleo/src/dispatch/types.ts`, `registry.ts`) — final arbiter for domain list, operation list, operation signatures
2. **CLEO-OPERATION-CONSTITUTION.md** — normative spec derived from code; wins over conceptual docs on operational claims
3. **Owner Memory** (`~/.claude/projects/-mnt-projects-cleocode/memory/MEMORY.md`) — owner corrections, especially identity (e.g., "6 systems not 4"); wins over aged canon
4. **CLEO-VISION.md** — conceptual identity; deferential to owner memory but authoritative for new contributors
5. **CLEO-ARCHITECTURE-GUIDE.md** — plain-English guide; must mirror Vision and Constitution
6. **CLEO-SYSTEM-FLOW-ATLAS.md** — visual diagrams; must mirror Architecture Guide
7. **Design docs** (`docs/design/*`) — UI / interaction specs; consume canon; never define it
8. **Narrative stories** (`CLEO-MANIFESTO.md`, `CLEO-AWAKENING-STORY.md`, `CLEO-FOUNDING-STORY.md`) — historical voice; MAY preserve legacy terminology inline with editorial notes

Violations of this hierarchy MUST be flagged in PRs and reconciled before merge.

### Decision 5: Continuous Drift Prevention

Future drift prevention measures to be scheduled under epic T636:

1. **`cleo check:canon`** CLI operation — parses concept/spec docs and compares system list, domain list, and structural claims to `types.ts` + `registry.ts`. Fails non-zero when claims diverge. Runs in CI as a blocking gate.
2. **Registry auto-generation for counts** — sections of docs that quote operation counts should be auto-generated markers (e.g., `<!-- REGISTRY_OP_COUNT -->` tokens) replaced at build time, so docs cannot drift on the moving count.
3. **PR template check** — when `docs/concepts/*.md` or `docs/specs/*.md` change without a corresponding `check:canon` pass, CI warns.

Implementation is out of scope for this ADR (queued as follow-up task under T636).

---

## Residual Drift (discovered post-`f336395a`, out of scope for this ADR's merge)

The bulk reconciliation commit `f336395a` fixed 19 files. A subsequent grep across `/mnt/projects/cleocode` surfaced these residual references to "Circle of Ten" and/or "Four systems" — to be triaged in a follow-up task:

### High-priority (spec + architecture docs)

| File | Lines | Notes |
|------|-------|-------|
| `docs/specs/STICKY-NOTES-SPEC.md` | 65, 78 | "Circle of Ten house" — update to Eleven |
| `docs/specs/CLEO-CONDUIT-PROTOCOL-SPEC.md` | 195 | Table row — update to Eleven |
| `docs/specs/CANT-EXECUTION-SEMANTICS.md` | 1265, 1323 | Validation rules reference "canonical Circle of Ten" |
| `docs/specs/CLEO-AUTONOMOUS-RUNTIME-SPEC.md` | 19, 45, 141 | Runtime spec references |
| `docs/architecture/TYPE-CONTRACTS.md` | 564 | Namespace export comment |

### Medium-priority (design docs — UI layer consumes canon)

| File | Notes |
|------|-------|
| `docs/design/QUICK-REFERENCE.md` | UI aspect mapping |
| `docs/design/CLEO-PI-HARNESS-ARCHITECTURE.md` | Hearth + Circle integration |
| `docs/design/CLEO-PI-AGENT-TUI-DESIGN.md` | UI mapping section |
| `docs/design/CLEO-PI-HARNESS-WIREFRAMES.md` | Lore integration language |
| `docs/design/PI-EXTENSION-MAPPING.md` | Extension mapping |

### Low-priority (code comments referencing UI labels)

| File | Notes |
|------|-------|
| `packages/cleo-os/extensions/tui-theme.{ts,js,d.ts}` | UI theme comments |
| `packages/cleo-os/extensions/cleo-agent-monitor.ts` | Agent monitor comments (also renders UI labels) |

### Historical / narrative (preserve)

| File | Notes |
|------|-------|
| `docs/concepts/CLEO-CANT.md` | Narrative section referring to Circle's founding |
| `docs/concepts/CLEO-AWAKENING-STORY.md` | Historical story voice |
| `docs/concepts/CLEO-FOUNDING-STORY.md` | Historical story voice |
| `docs/archive/*` | Archival — DO NOT touch |

Historical narratives MAY keep legacy terminology if an editorial note clarifies the current canon. This preserves the "what it felt like then" tone the stories are written in.

---

## Consequences

**Positive**:

- New contributors can trust that `types.ts` + Constitution define what CLEO is, without having to reconcile three or more sources in their head
- Future drift has a clear escalation path (the SSoT hierarchy) instead of three-way contradictions
- `cleo check:canon` (once shipped) converts drift from "discovered incidentally" to "caught in CI"

**Negative / trade-offs**:

- Existing links in blog posts, Slack, other internal docs to "Four Great Systems" will read as out-of-date; no way to retroactively fix them
- The `intelligence` domain has a shorter track record than the other 10 — if it ever gets absorbed into `check`, this ADR will need an update
- Canon-check automation is not included in this ADR's merge scope; residual drift remains findable until that CI gate ships

**Rollback**:

This ADR is editorial. Rolling back means reverting the 3-line fix in `CLEO-ARCHITECTURE-GUIDE.md` and this ADR file. No code impact. No migration impact.

---

## Related work

- Commit `f336395a` — bulk canon reconciliation across 19 files (v2026.4.44)
- ADR-042 — CLI system integrity + Conduit alignment (partially superseded by T565)
- T565 — `intelligence` domain introduction
- T636 (parent epic) — this plan's full execution; residual drift triage is T636's sibling task queue
- T637 (this task) — the three line fixes in CLEO-ARCHITECTURE-GUIDE.md + this ADR draft

## References

- `docs/concepts/CLEO-ARCHITECTURE-GUIDE.md` — plain-English canonical guide (now 6 systems / 11 domains after lines 51, 227, 228 fix)
- `docs/concepts/CLEO-VISION.md` — conceptual identity charter
- `docs/specs/CLEO-OPERATION-CONSTITUTION.md` v2026.4.42 — normative operation spec
- `packages/cleo/src/dispatch/types.ts` — `CANONICAL_DOMAINS` array SSoT
- `packages/cleo/src/dispatch/registry.ts` — `OPERATIONS` array SSoT
- `~/.claude/projects/-mnt-projects-cleocode/memory/MEMORY.md` — owner correction log
