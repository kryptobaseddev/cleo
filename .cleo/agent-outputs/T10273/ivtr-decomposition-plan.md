# IVTR Autonomy — Saga Decomposition Plan (Wave 3 / T10273)

**Saga**: T10268 SG-IVTR-AUTONOMY · **Mode**: Investigation only — no tasks created, no code edits.
**Predecessors**: T10269 steal-table, T10270 audit, T10271 ADR quartet, T10272 council verdict.
**Author**: Wave-3 epic-architect agent · **Date**: 2026-05-23

This document routes the four Wave-1 ADRs (A–D) — each PROPOSED with council
verdict NEEDS-REWORK or REJECTED-FROM-SAGA — into existing Sagas where
appropriate, and proposes ONE new Saga skeleton for the IVTR-native work
that nothing else owns. No tasks are filed.

---

## 1. Executive Summary — Routing Table

| ADR | Council verdict | Destination | Size | Earliest wave |
|---|---|---|---|---|
| A — `adr-079-ac-stable-ids` | NEEDS-REWORK (3 advisors MODIFY, 1 PASS) | **NEW Saga SG-IVTR-AC-BINDING** (proposed) | XL (4 waves, 4–5 Epics) | After ADR-A rewrite (action items #1–4) lands |
| B — `adr-079-independent-validator` | NEEDS-REWORK (1 FAIL, 3 MODIFY, 0 PASS) | **NEW Saga SG-IVTR-AC-BINDING** Wave 2+ (same Saga as A — load-bearing AC-ID dependency) | L (3 waves, 3 Epics) | Blocked on Saga Wave 1 + Validator skill body |
| C — `adr-079-docs-as-active-validator` | NEEDS-REWORK (2 FAIL, 1 PASS, 2 MODIFY) | **Route to T9625 SG-CLEO-DOCS-CANON** as a new Epic (E-DOCS-VALIDATOR) | L (2 waves) | After ADR-C broadened to all DocKinds + ADR-A IDs stable |
| D — `adr-079-core-tools-first-class` | **REJECTED FROM SAGA** (2 FAIL, 1 MODIFY, 1 PASS) | **Re-file under T9831 SG-ARCH-SOLID follow-on** as a tightly-scoped Epic (4 tools, not 50) — gated by T10156 reconciliation | M (1 wave, IVTR-feeding subset only) | After T10156 closed |

**The first new Saga to spin up next session: `SG-IVTR-AC-BINDING` Wave 0
(ADR-A rewrite + override-path unification + history-model collision
decision).** Details in §4.

---

## 2. Per-ADR Routing

### 2.1 ADR-A — AC Stable IDs + `satisfies:` atom

**Council verdict** (verbatim, §3.1): *"NEEDS-REWORK. The core idea (per-AC
stable IDs + `satisfies:` atom + AC-coverage check at complete) is sound and
Executor-passable. But the dual-ID system (positional + hash) is
over-engineered… Rework: pick ONE canonical ID (UUID-v4 at AC creation;
positional alias for display), keep `_history` for drift. Also resolve
cross-task binding (currently DEFERRED) before shipping."*

**Action items affecting routing** (cited by council §4):

- #1 — Replace dual-ID with single canonical UUID + positional alias.
- #2 — Answer cross-task `satisfies:` binding **before** any sibling ADR consumes the format.
- #3 — Add new-contributor walkthrough to migration plan.
- #4 — Ship the 8-PR drizzle migration as drafted (Executor PASS).
- #18 — Decide history-model collision (`docs_provenance` vs `task_acceptance_criteria_history`).

**Destination decision + rationale**: **NEW Saga `SG-IVTR-AC-BINDING`** (see
skeleton in §4). Rationale:

- AC ID format is the **load-bearing primitive for three of the four ADRs**
  (council §3.2 cross-cutting concern #1). It is the sole top-of-graph
  dependency. It does not fit in T9625 (docs) — ACs are task-domain, not
  doc-domain. It does not fit in T9585 (worktree IVTR shipped end-to-end
  for v2026.5.81 — closeout was an integration Saga, not an IVTR-semantics
  Saga). It does not fit in T9799 (skills v2) — schema migrations are not
  the skills lane.
- The new Saga groups ADR-A + ADR-B because Worker→Validator handoff
  requires AC IDs to exist, and the council called out (#5–#6) that
  ADR-B's Validator SKILL body must ship in the same PR as the contract.
  Bundling them under one Saga forces the cross-Wave Gantt the council
  demanded (action #12).

**Prerequisites/blockers**:

- **Council action #1 + #2** must land as an ADR-A revision (call it
  ADR-079-r1) before any code lands.
- **Action #18 — history-model collision**: the council recommended
  extending `docs_provenance` to absorb AC history. This decision MUST
  precede the drizzle migration in action #4 because the migration
  introduces `task_acceptance_criteria_history` and would be wasted work
  if `docs_provenance` becomes the canonical store. Owner gates this
  via one saga-level decision spike.

**Out-of-scope items the council flagged that belong elsewhere**:

- **Action #15 — unify override paths** (`CLEO_OWNER_OVERRIDE`,
  `--ac-defer`, `lead.escalate`, editorial waiver) into one `cleo
  override` verb. This is cross-cutting and touches release pipeline +
  evidence pipeline + lifecycle. Suggested home: a future
  `SG-OVERRIDE-UNIFY` (out of scope this Saga; capture as cross-cutting
  follow-up note — see §3 dependency graph).

### 2.2 ADR-B — Independent Validator Role

**Council verdict** (§3.1): *"NEEDS-REWORK. Validator role and Lead-owned
loop accepted in principle. But Expansionist's FAIL on the missing skill
body is decisive: this ADR specifies a contract for behaviour nobody has
written. Rework: ship Validator SKILL.md in the same PR as the contract.
Add infra-fault rows to the Max-N table. Measure baseline confirmation-
bias rate against the t9187 corpus BEFORE adopting the 2–4× cost
multiplier as policy."*

**Action items affecting routing** (cited by council §4):

- #5 — Validator SKILL.md ships in same PR as contract (NOT follow-up).
- #6 — Add infra-fault rows (timeout, Conduit-drop, validator-OOM) to Max-N table.
- #7 — One-week measurement spike vs t9187 corpus.
- #8 — Adopt GSD-2 model-tier table verbatim in D7.3.
- #9 — Convert `lead-rollup.ts` `mode:'active'` to feature flag, keep callers untouched.

**Destination decision + rationale**: **Same new Saga
`SG-IVTR-AC-BINDING`, Wave 2+**. Rationale:

- ADR-B's `AcFinding.acId` consumes ADR-A's ID format directly (council
  cross-cutting #1). Splitting them across Sagas re-creates the parallel-
  Wave-1 mess that produced four ADR-079 collisions.
- The Validator SKILL body could live in T9799 SG-CLEO-SKILLS-V2
  (skills lane), but the SKILL is a deliverable of the Validator
  contract — its rubric, role, tool-strategy are bound to the contract.
  Council action #5 explicitly says "same PR". Forcing the skill into a
  different Saga re-creates the gap that triggered the FAIL.
- T9585 SG-CLEO-CORE-V2 ("worktree IVTR + audit-v2") is **done** for
  v2026.5.81 — it integrated workflow plumbing, not validator semantics.
  Re-opening it would be incorrect — that Saga's "worktree IVTR" was
  context-isolation infra, not validator role.

**Prerequisites/blockers**:

- ADR-A revision merged.
- Validator SKILL.md drafted (the "silent prerequisite" the council named
  in cross-cutting #2) — listed as an explicit deliverable in the Saga
  wave plan §4.
- t9187 corpus available for measurement spike (Wave 0 task in the new
  Saga).

**Out-of-scope items**:

- Conduit transport hardening for `validator.verdict` message (Outsider's
  finding on timeout/drop). If the drop frequency turns out to be
  non-trivial during the measurement spike, file as a follow-up under
  the existing Conduit transport lane (no Saga exists yet — capture as
  future `SG-CONDUIT-RELIABILITY`).

### 2.3 ADR-C — Docs as Active Validator

**Council verdict** (§3.1): *"NEEDS-REWORK. Structural insight (spec drift
is a signal the `documented` gate misses) is correct. But Expansionist's
FAIL on `spec`-only scoping is correct — the ADR's own existence as an
ADR (with MUST clauses for its own implementation) proves the abstraction
needs `adr` from day 1. Rework: broaden Decision 4.2 to register
`validator` metadata on ANY DocKind that opts in. Contract-test
`llmtxt.semanticDiff`. Add saga-level Gantt ordering Phase C/D against
ADR-A and ADR-B shipments."*

**Action items affecting routing**:

- #10 — Broaden validator metadata to ANY DocKind that opts in.
- #11 — Contract-test `llmtxt.semanticDiff` classifier.
- #12 — Saga-level Gantt ordering Phase C/D against A and B.
- #13 — Three-audience separation (doc-author / tool-builder / validator-agent) into 3 sub-sections.

**Destination decision + rationale**: **Route into T9625
SG-CLEO-DOCS-CANON as a NEW Epic `E-DOCS-VALIDATOR`**. Rationale:

- T9625's existing scope (council verified §2.3 audit) covers "cleo docs
  + llmtxt SDK as canonical project docs SSoT" — `BUILTIN_DOC_KINDS`,
  `canonicalHome`, `publishMirror`, `rawMdPaths`. Adding validator
  metadata to those same DocKinds is a natural extension of the same
  taxonomy; it does NOT require its own Saga.
- T9625's existing AC #4 (*"ct-docs-* skills read+write through llmtxt
  SDK not filesystem"*) and AC #8 (*"Validation gate: SG-CLEO-SKILLS
  handoff doc round-trips"*) already anticipate validator hooks at the
  doc layer.
- The `llmtxt.semanticDiff` classifier is upstream of CLEO. T9625
  already operates the "file gaps as GH issues against llmtxt repo"
  pattern (AC #7) — the contract-test pin (action #11) fits that
  workflow exactly.
- Council action #12 (saga-level Gantt) is satisfied by routing C
  *inside* the docs Saga but with a documented dependency edge on
  `SG-IVTR-AC-BINDING` Wave 1 (ADR-A IDs stable, see §3).

**Proposed new Epic skeleton** (filed inside T9625, NOT a new Saga):

- **Epic title**: `E-DOCS-VALIDATOR: docs as active validator —
  ac-bindings front-matter + spec atom + semanticDiff CI gate (T9625 AC8
  extension)`
- **Acceptance** (drafted, not filed):
  1. `BUILTIN_DOC_KINDS` gains opt-in `validator` block (any DocKind, not just `spec`) — council action #10.
  2. `spec:<slug>#<clauseId>` evidence atom registered in `evidence.ts` atom grammar.
  3. `cleo docs bind` and `cleo check spec-drift` CLI verbs ship.
  4. Contract tests pin `llmtxt.semanticDiff` editorial-vs-structural classifier — council action #11.
  5. Three-audience README split (doc-author / tool-builder / validator) — council action #13.
  6. Saga-level Gantt documented in T9625 README updates Wave 1/2 ordering against `SG-IVTR-AC-BINDING`.
- **Expected child tasks**: 5–7 (one per AC plus the SDK extension PR + the docs migration).
- **Wave count**: 2 (Wave 0 — DocKind extension + atom; Wave 1 — semanticDiff contract tests + CLI verbs + Gantt).

**Prerequisites/blockers**:

- `SG-IVTR-AC-BINDING` Wave 1 done (AC IDs are stable — required because
  `spec:<slug>#<clauseId>` atom binds to AC IDs via the front-matter
  `ac-bindings:` block).
- `llmtxt@2026.4.13` `semanticDiff` API contract pinned + monitored.

**Out-of-scope items**:

- The "single new contributor walkthrough" the council recommended for
  ADR-A also applies to ADR-C's audience mix. The same docs walkthrough
  pattern can carry both — captured under T9625's existing AC #4.

### 2.4 ADR-D — CORE Tools First-Class

**Council verdict** (§3.1): *"REJECTED for this Saga. ADR-D is a CORE
refactor that legitimately belongs to T9831 SG-ARCH-SOLID, not T10268
SG-IVTR-AUTONOMY… Re-file under T9831 with an explicit IVTR-feeding
subset: only `validator.*`, `agent.request-hitl`, `worker.send-message`,
`spawn.validator` — 4 tools, not 50."*

**Action items affecting routing**:

- #14 — Verify or replace T10156 prerequisite reference.
- #17 — Re-file under T9831 SG-ARCH-SOLID with IVTR-feeding subset (4 tools).

**Destination decision + rationale**: **T9831 SG-ARCH-SOLID follow-on
(post-Saga cleanup Epic)**. Rationale:

- T9831 is **DONE** but has a known follow-up: T10156 *("T9831 saga
  DB-stale: T9837 E-SSOT-ENFORCEMENT marked done but 5 lint scripts
  MISSING from scripts/")* — STATUS=pending, P1. Filesystem check
  (verified 2026-05-23) shows all 5 scripts EXIST on disk:
  `scripts/lint-cli-package-boundary.mjs` (536 LOC),
  `lint-no-raw-define-command.mjs` (294 LOC),
  `lint-contracts-fan-out.mjs` (497 LOC),
  `lint-no-ssot-exempt.mjs` (448 LOC),
  `lint-no-direct-db-open.mjs` (388 LOC). So T10156 is a DB-stale
  reconciliation, not a missing-work bug. Closing T10156 unblocks
  ADR-D's strict-mode lint flip (Decision 6 in the original ADR-D).
- The full ADR-D scope (50 tools, CLI/Studio/MCP refactor) is a separate
  multi-Saga endeavor and out of scope for IVTR autonomy.
- The IVTR-feeding **subset** (4 tools: `validator.attest`,
  `validator.reject`, `validator.ac-pull`, `spawn.validator`; plus
  `worker.send-message` and `agent.request-hitl` already exist or are
  trivial wrappers) IS in scope for `SG-IVTR-AC-BINDING` Wave 2 — see
  §4 wave plan. Those 4 tool definitions are co-located with the
  Validator SKILL body (council action #5).

**Proposed routing**:

- **Re-file ADR-D as `ADR-082` under T9831 follow-on** (post-saga
  cleanup track). Title: *"CORE Tools first-class — full registry +
  CLI/Studio/MCP refactor"*. Effort: XL. Out-of-scope this Saga.
- **The 4 IVTR-feeding tools** ship inside `SG-IVTR-AC-BINDING` Wave 2
  alongside ADR-B implementation. They use the existing `defineSdkTool`
  factory (already in `packages/core/src/tools/task-tools/sdk-tool.ts`)
  — no new registry required.

**Prerequisites/blockers**:

- **T10156 reconciliation** is the blocker named by council action #14.
  Trivial DB-state fix (the scripts exist; just mark T10156 done with
  evidence atoms `files:scripts/lint-*.mjs;tool:lint`). Recommended
  next-session opportunistic close — does not need a Saga.

**Out-of-scope items**:

- The 5,861 string-literal op names + 616 hand-rolled envelopes (cited
  in the rejected ADR-D from a different Saga's master plan) are not
  IVTR-shaped work. Capture as a future T9831 cleanup follow-up; do not
  spin a Saga from this council session.

---

## 3. Cross-Cutting Dependencies (Saga-level graph)

```
SG-IVTR-AC-BINDING (NEW)
  ├── Wave 0  ADR-A revision (action #1, #2, #18) + Validator SKILL draft (#5)
  │           override-path unification design sketch (#15) — sketch only
  │           t9187 measurement spike (#7) — runs in parallel
  ├── Wave 1  ADR-A migration: drizzle 8-PR sequence (#4) + new contributor walkthrough (#3)
  │           cross-task `satisfies:` binding semantics shipped (#2)
  ├── Wave 2  ADR-B Validator role + 4 IVTR-feeding tools (subset of ADR-D, #17)
  │           SKILL body shipped same PR as contract (#5)
  │           Max-N infra-fault rows added (#6)
  │           lead-rollup feature flag (#9)
  │           GSD-2 model-tier defaults (#8)
  └── Wave 3  Saga close-out — renumber ADRs 079→082 (#16) + saga retrospective

T9625 SG-CLEO-DOCS-CANON  ──→  blocked-on  ──→  SG-IVTR-AC-BINDING Wave 1
  └── E-DOCS-VALIDATOR (new Epic inside T9625)
      ├── DocKind validator block (any DocKind, #10)
      ├── `spec:` atom registration (consumes AC IDs from Wave 1)
      ├── llmtxt.semanticDiff contract test (#11)
      └── Three-audience README split (#13)

T9831 follow-on  ──→  blocked-on  ──→  T10156 reconcile
  ├── T10156 close (trivial DB-stale fix — scripts exist on disk)
  └── ADR-082 full registry refactor (XL, separate future Saga)

Future follow-up captures (no Saga yet):
  - SG-OVERRIDE-UNIFY (council action #15)
  - SG-CONDUIT-RELIABILITY (validator.verdict drop handling)
  - SG-T9831-CLI-DEDUP (5,861 op-names + 616 envelopes)
```

**Critical-path edge**: `SG-IVTR-AC-BINDING` Wave 1 gates the IVTR-loop
unlock. Nothing in T9625's `E-DOCS-VALIDATOR` ships until those AC IDs
stabilise — because `spec:<slug>#<clauseId>` atoms bind to them. This is
exactly the saga-level Gantt the council demanded (action #12).

---

## 4. Recommended Next Session Kick-Off

**Start `SG-IVTR-AC-BINDING` Wave 0 next session.** Specifically:

- **First action**: file the new Saga via `cleo saga create` with the
  skeleton below.
- **Second action**: file Wave 0's 3 epics (revision Epic, SKILL-body
  Epic, measurement-spike Epic).
- **Third action**: opportunistically close **T10156** (trivial:
  evidence atoms `files:scripts/lint-cli-package-boundary.mjs,scripts/
  lint-no-raw-define-command.mjs,scripts/lint-contracts-fan-out.mjs,
  scripts/lint-no-ssot-exempt.mjs,scripts/lint-no-direct-db-open.mjs;
  tool:lint`). Closing it removes the only stated blocker for the ADR-D
  IVTR-feeding subset in Wave 2.

**Saga skeleton — SG-IVTR-AC-BINDING** (PROPOSED, not filed):

- **Title**: `SG-IVTR-AC-BINDING: AC stable IDs + independent Validator role + IVTR-feeding tool subset`
- **Description (1-sentence)**: Closes the IVTR rubber-stamp gap by giving every AC a stable canonical ID, a `satisfies:` evidence atom, an independent Validator role with Lead↔Worker Max-N loop, and the 4 CORE tools that loop requires. Builds on T10268 SG-IVTR-AUTONOMY Wave-1 ADR quartet (rework lands here).
- **Acceptance criteria (7)**:
  1. ADR-079-r1 (AC stable IDs, single canonical UUID + positional alias) accepted; ADR-082 (Validator role) accepted; ADR-083 (`satisfies:` atom + AC-coverage gate) accepted — council rework items #1, #2, #5–#9 closed.
  2. Drizzle migration shipped end-to-end (8 PRs) including `task_acceptance_criteria` + `evidence_ac_bindings` + history-table OR `docs_provenance` extension (council action #18 resolved before this AC).
  3. `satisfies:<ac-id>` atom kind added to `evidence.ts:186-219` grammar with pairing rule (cosmetic-binding rejected).
  4. `.cleo/skills/cleo-validator/SKILL.md` shipped with role + philosophy + tool-strategy + output-formats + execution-flow + success-criteria sections (council action #5).
  5. 4 IVTR-feeding tools (`validator.attest`, `validator.reject`, `validator.ac-pull`, `spawn.validator`) registered via existing `defineSdkTool` factory and scoped per-tier — closes the ADR-D IVTR subset without scope-creep into the full ADR-D refactor.
  6. t9187 measurement spike report filed via `cleo docs add --type research` — establishes baseline false-positive rate and validates the 2–4× cost multiplier policy quantitatively (council action #7).
  7. Saga-level phase Gantt documented; new-contributor walkthrough doc filed (council actions #3 + #12).
- **Proposed wave plan**:
  - **Wave 0** (parallel-safe, 3 Epics):
    - `E-ADR-A-REVISION` — ADR-079-r1 + cross-task binding semantics + history-collision decision spike (size: M).
    - `E-VALIDATOR-SKILL-DRAFT` — `.cleo/skills/cleo-validator/SKILL.md` draft + Max-N infra-fault rows (size: S).
    - `E-T9187-SPIKE` — one-week measurement vs t9187 corpus (size: S).
  - **Wave 1** (sequential after Wave 0):
    - `E-AC-MIGRATION` — drizzle 8-PR sequence + `_history` table + cross-task `satisfies:` shipping (size: L, ~8 child tasks).
    - `E-NEW-CONTRIBUTOR-WALK` — guided ramp doc for the 7-concept CLI invocation (size: S).
  - **Wave 2** (sequential after Wave 1):
    - `E-VALIDATOR-ROLE` — `validator` role at contract layer + Lead↔Worker Max-N loop + 4 IVTR-feeding tools + lead-rollup feature flag (size: L, ~6 child tasks).
  - **Wave 3** (Saga close-out):
    - `E-IVTR-CLOSEOUT` — ADR renumbering 079→082 + retro + integration verify (size: S).
- **Expected Epic count**: 7 across 4 waves (3 + 2 + 1 + 1).
- **Expected leaf-task count**: 25–30 (within 4–10 per Epic ratio).

**Why this Saga first**: every other ADR's downstream work (`E-DOCS-
VALIDATOR` under T9625; the ADR-D IVTR-feeding subset under T9831) is
blocked on stable AC IDs landing in Wave 1. Starting `SG-IVTR-AC-BINDING`
first is the unique unblocking path.

---

## 5. Renumbering Chore

All four Wave-1 ADRs claim **ADR-079** — collision confirmed via the four
slugs `adr-079-ac-stable-ids`, `adr-079-independent-validator`,
`adr-079-docs-as-active-validator`, `adr-079-core-tools-first-class`. The
council declared but did not rename (§3.6).

**Proposed binding numbers** (dependency-order, matching council's own
recommendation):

| Number | Slug | Subject | Rationale |
|---|---|---|---|
| **ADR-079** | `adr-079-ac-stable-ids` | AC stable IDs (ADR-A) | Foundational atom — every other ADR consumes its ID format |
| **ADR-080** | `adr-080-independent-validator` | Independent Validator role (ADR-B) | Consumes AC IDs in `AcFinding.acId` |
| **ADR-081** | `adr-081-docs-active-validator` | Docs as active validator (ADR-C) | Consumes AC IDs in front-matter `ac-bindings:` |
| **ADR-082** | `adr-082-core-tools-first-class` | CORE tools first-class (ADR-D) | Consumes AC IDs via `validator.ac-pull` — kept reserved even though re-filed under T9831 follow-on |

**Criterion: dependency order** (council §3.6 explicit recommendation —
matches the natural read order and the "ADR-A is the critical path"
finding).

**Do NOT rename now**. The rename is a single-PR cleanup chore to file
inside `SG-IVTR-AC-BINDING` Wave 3 (`E-IVTR-CLOSEOUT`, council action
#16). Renaming before the ADRs accept their rework would cause merge
conflicts with in-flight revisions.

---

## 6. Items Not Routed (Future Follow-Up Notes)

Cross-cutting concerns out of scope for the four-ADR routing, captured
but NOT filed:

- **Override-path unification** (#15): converge `CLEO_OWNER_OVERRIDE` +
  `--ac-defer` + `lead.escalate` + editorial waiver to one `cleo
  override` verb. Future Saga `SG-OVERRIDE-UNIFY`.
- **Conduit `validator.verdict` reliability** (Outsider/ADR-B). Future
  Saga `SG-CONDUIT-RELIABILITY` if Wave 2 stress-tests show drops.
- **Full ADR-D refactor — 5,861 op-names + 616 envelopes**: post-T9831,
  enormous, not IVTR-shaped. Future Saga `SG-T9831-CLI-DEDUP`.
- **History-model loser cleanup** (#18): single-PR follow-up after Wave 0
  picks `docs_provenance`-absorbs-AC vs separate history table.
- **Full 50-tool ADR-082 catalog**: reserved slot, not opened until
  `SG-IVTR-AC-BINDING` finishes.

---

*End of decomposition plan. No tasks have been filed; no code has been
edited. Next session: file `SG-IVTR-AC-BINDING` via `cleo saga create`,
file its Wave-0 Epics, and opportunistically close T10156.*
