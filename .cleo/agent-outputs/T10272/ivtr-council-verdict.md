# IVTR Autonomy Council Verdict (Saga T10268 · Wave 1 · 4 ADRs)

**Mode:** Investigation only · **Date:** 2026-05-23 · **Reviewer agent:** ct-council (5-lens simulation)

## 1. Methodology

This review covers the four Wave-1 ADRs produced under SG-IVTR-AUTONOMY (T10268), all of which were authored in parallel and all of which claim ADR-079 (numbering collision — addressed in the Chairman section). The four lanes are:

- **ADR-A** (slug `adr-079-ac-stable-ids`) — AC stable IDs + `satisfies:` evidence atom + AC-coverage gate at `cleo complete`.
- **ADR-B** (slug `adr-079-independent-validator`, file `adr-independent-validator.md`) — `validator` agent role with Lead-owned Worker↔Validator loop and Max-N escalation.
- **ADR-C** (slug `adr-079-docs-as-active-validator`) — `cleo docs` upgraded from passive SSoT to active validator via front-matter AC bindings + `spec:<slug>#<clauseId>` atom + `cleo check spec-drift` CI gate.
- **ADR-D** (slug `adr-079-core-tools-first-class`, file `adr-core-tools-first-class.md`) — `defineTool` factory + `CoreToolRegistry` + thin-handler CLI/Studio refactor with 5 promoted lint scripts.

Each ADR was passed through five sequential lenses — Contrarian, First Principles, Expansionist, Outsider, Executor — grounded in repo state verified on 2026-05-23 (e.g. `packages/core/src/tools/` contains no `agents/` subdir; the 5 lint scripts referenced in ADR-D exist on disk at `scripts/lint-*.mjs`; `evidence.ts` is 1,711 LOC; `ivtr-loop.ts` is 981 LOC; `req.ts` is 363 LOC). Each advisor was required to produce a distinct finding; redundant praise was disallowed. A verdict of PASS / MODIFY / FAIL was demanded — the council does NOT exist to rubber-stamp ADRs the IVTR saga is itself trying to fix.

---

## 2. Per-ADR Verdicts

### 2.1 ADR-A — AC Stable IDs + `satisfies:` atom

| Advisor | Verdict | Top finding |
|---|---|---|
| Contrarian | MODIFY | The `@hash` suffix is "OPTIONAL in user input" then "MUST be re-stored on edit" — D1 and D6 conflict. If display-ID form (`T9614-ac03`) is the common path, drift detection regresses to silent silent-rebinding, defeating the ADR's own audit purpose. Agents will type the short form 99% of the time. |
| First Principles | MODIFY | Why position-padded *and* content-hashed? You picked two ID systems because each has a defect; the union has *both* defects (positional silent-rebind on reorder + hash unmemorability). The principled answer is one stable surrogate key per AC (UUID generated at create, stored once) and a *display alias* derived from position — not two parallel IDs both of which can drift. |
| Expansionist | MODIFY | Cross-task AC binding is "DEFERRED to spike T10275" but it's a load-bearing case: when an Epic ships across 3 PRs, evidence from PR-2 satisfies an AC defined on the Epic, not on the worker's leaf task. Without that, `satisfies:` will leak `CLEO_OWNER_OVERRIDE` usage at Epic→Saga boundaries — the very thing this ADR exists to close. |
| Outsider | MODIFY | A new contributor reading `cleo verify T9614 --gate implemented --evidence "commit:abc;files:src/timer.ts;satisfies:T9614-ac01,T9614-ac02"` has to understand: atoms, atom kinds, AC IDs, hashes, gates, gate state machines, the `_history` table, and the `partial → passed → failed → stale` state machine. That is 7 concepts in one CLI invocation. Authoring burden is real. |
| Executor | PASS | Migration is well-decomposed (8 PR slices, additive tables, no destructive rewrite of `acceptance_json`). The drizzle-kit migration shape matches recent merged work (e.g. PR #325 provenance backfill). Concrete code anchors (`evidence.ts:186-219`, `req.ts:174-280`, `gate-runner.ts:81-114`) are verifiable in repo. Ship-able as drafted. |

### 2.2 ADR-B — Independent Validator + Lead↔Worker Max-N Loop

| Advisor | Verdict | Top finding |
|---|---|---|
| Contrarian | MODIFY | The "fresh-context Validator avoids confirmation bias" argument is borrowed from GSD-2 marketing, not from CLEO evidence. There is no CLEO data showing a same-context validator FAILS more than a different-context one. Until that's measured (e.g. against the `t9187-evidence` campaign corpus), the 2-3x cost multiplier in §3.1 is speculative. |
| First Principles | MODIFY | "Validator must not see worker's reasoning" is asserted but the Validator IS handed `diff`, `specRefs`, `acceptanceCriteria`, and `previousFindings`. If the worker writes the spec docs (very common in CLEO today — workers attach specs as part of `implemented`), the validator IS seeing worker reasoning, just laundered through the canon-docs SSoT. The isolation is theatre unless spec authorship is also scoped. |
| Expansionist | FAIL | The ADR specifies the LOOP but not the **Validator's training surface**. What does the Validator skill actually contain? Where do its rubrics live? Without a defined `.cleo/skills/cleo-validator/SKILL.md` body (only mentioned as "MUST ship" in D8), the role is a contract with no behaviour. Two siblings ADR-C and ADR-D depend on this skill existing; the ADR doesn't say who writes it or what it asserts. |
| Outsider | MODIFY | The state-machine ASCII art and the Max-N tables are well-drawn, but a new contributor cannot answer "what happens if the Validator times out?" or "what happens if Conduit drops the `validator.verdict` message?" The ADR is strong on success/failure paths and silent on infrastructure-fault paths. Add a third axis to the table: `unreachable | malformed | timeout`. |
| Executor | MODIFY | Cost multiplier of 2-4x at p90 is unmeasured but plausible given current Worker→PR ratios. The hard issue: `lead-rollup.ts` `active` mode (D8) is a behavior change to a function that is currently passive and read-only across 200+ call sites. The "additive — existing callers continue to work" claim is testable but not yet tested. Needs a feature-flag entry point on the existing function, not a new mode parameter. |

### 2.3 ADR-C — Docs as Active Validator

| Advisor | Verdict | Top finding |
|---|---|---|
| Contrarian | MODIFY | `semanticDiff` from external `llmtxt@2026.4.13` is the load-bearing primitive for the YELLOW/RED downgrade rule (§4.4). If that dep's "editorial vs structural" classifier is wrong even 10% of the time, the entire spec-drift gate becomes either a noise generator or a false-clean signal. The ADR pins the dep but does not contract-test the classifier. |
| First Principles | PASS | The argument that spec atoms are STRUCTURALLY different from test atoms (§4.5 table) is correct from primitives: not every invariant is runtime-testable, and the existing `documented` gate already accepts non-test atoms (`files:`, `url:`). Adding `spec:` as a sibling is principled, not invented. The asymmetric drift rule (spec changed but code didn't → RED; vice versa → YELLOW) is also derivable from first principles: post-hoc spec-edit-to-match-code is the abuse vector, code-edit-without-spec-update is mere staleness. |
| Expansionist | FAIL | The ADR scopes itself to `spec` DocKind only and says "ADR, research, plan, note, handoff MAY also gain a `validator` block in a follow-up." But the audit (`ivtr-current-state-audit` §2.5 / G7) says the gap is broader. An ADR that ships an ADR-document with embedded MUST clauses about its own implementation (recursive — this ADR is doing exactly that) needs the ADR DocKind to also be validator-aware. Restricting to `spec` only is artificial; the abstraction must support `adr` from day 1. |
| Outsider | FAIL | The ADR mixes three audiences. (1) Doc author: "write `ac-bindings:` in front-matter." (2) Tool builder: "implement `SpecClauseExtractor`." (3) Validator agent (ADR-B's role): "consume the SDK primitive." None of these are clearly walled. A new contributor cannot tell whether `cleo docs bind` is a tool the agent runs, a CLI a human runs, or both. The "no implementation in this PR" disclaimer makes it worse — there's no concrete trace. |
| Executor | MODIFY | The phase plan (A→B→C→D) is the most well-defined of the four ADRs. But Phase C ("REQUIRED FOR T-CRITICAL P0/P1") depends on ADR-A having shipped (stable AC IDs) AND ADR-B having shipped (Validator that consumes `SpecValidator.validate`). Lockstep is one thing; cross-ADR phase ordering is unstated. Needs a saga-level Gantt, not 4 independent migration plans. |

### 2.4 ADR-D — CORE Tools as First-Class SDK Primitives

| Advisor | Verdict | Top finding |
|---|---|---|
| Contrarian | FAIL | The "5,861 string-literal op names" and "616 hand-rolled envelopes" are cited from `sg-arch-solid-master-plan`, a doc this council has not seen and which is not part of the Wave-0 input set. Those numbers are doing heavy load-bearing work for the LOC-reduction promise (~40-60%) and the entire justification for Decision 6's lint enforcement. The ADR uses external-saga statistics to justify a refactor inside the IVTR saga. |
| First Principles | MODIFY | If "every CLI command handler MUST be a thin envelope around `CoreToolRegistry.invoke()`" (Decision 3, §2.3), then the registry IS the dispatch surface. So why is there both a `defineCommand` from citty AND a `CoreToolRegistry.invoke`? The principled answer is to make citty's `defineCommand` itself produce a registry entry (one registration site), not to have two parallel registration mechanisms (CLI route + tool name). |
| Expansionist | MODIFY | The catalog (~50 tools, §2.5) lists `validator.ac-pull`, `validator.attest`, `validator.reject` as Category A LLM-callable. But these are exactly the tools the Validator from ADR-B needs to call. If those tools are LLM-callable, they're discoverable to the Worker too (via auto-complete in skills). The scope-by-role mechanism (Decision 2) tries to fence this off, but a Worker skill that imports the validator's tool list will leak the surface. Tighter audit needed. |
| Outsider | FAIL | The ADR is 300+ lines and assumes the reader knows: ADR-039 envelopes, ADR-064 SDK Tools taxonomy, ADR-078 boundary registry, ADR-051 evidence atoms, T9831 SG-ARCH-SOLID decomposition, MCP-removal canon, citty's `defineCommand`, Zod-vs-JSON-Schema-draft-07 tradeoffs, OpenCode BUILTIN, Hermes `model_tools`, Claude Code tool schema, and Letta-Evals graders. This is 11 implicit prerequisites for one ADR. It will not be readable to anyone joining the project. |
| Executor | FAIL | **The T10156 claim is provably wrong.** The ADR states T10156 (P2 bug "lint scripts missing") is a prerequisite to be "reconciled" before this ADR is accepted. Filesystem check: `scripts/lint-cli-package-boundary.mjs`, `lint-no-raw-define-command.mjs`, `lint-contracts-fan-out.mjs`, `lint-no-ssot-exempt.mjs`, `lint-no-direct-db-open.mjs` ALL exist (verified 2026-05-23). But `cleo show T10156` returns no record — the task ID itself is unverifiable. ADR-D is gating its rollout on a task that may not exist. The promotion-to-strict in Phase F also requires LOC budgets that have not been measured. |

---

## 3. Chairman Synthesis

### 3.1 Per-ADR verdict

- **ADR-A (AC stable IDs)** — **NEEDS-REWORK**. The core idea (per-AC stable IDs + `satisfies:` atom + AC-coverage check at complete) is sound and Executor-passable. But the dual-ID system (positional + hash) is over-engineered: it picks two ID schemes specifically because each has defects, then asserts the union is fine. Contrarian and First Principles converged. Rework: pick ONE canonical ID (UUID-v4 generated at AC creation; positional alias for display), keep `_history` for drift, drop the dual-track confusion. Also resolve cross-task binding (currently DEFERRED) before shipping — it's not a deferred concern, it's a Wave-1 saga boundary case.

- **ADR-B (Independent Validator)** — **NEEDS-REWORK**. The validator role and the Lead-owned loop are accepted in principle. But Expansionist's FAIL on the missing skill body is decisive: this ADR specifies a contract for a behaviour that nobody has written. Rework: ship the Validator SKILL.md as part of the ADR's same PR (steal-table §2.3.3 gives the GSD-2 shape verbatim). Add the infra-fault rows to the Max-N table (timeout, Conduit-drop, validator-OOM). And measure baseline confirmation-bias rate against the t9187 corpus BEFORE adopting the 2-4x cost multiplier as policy — at minimum, define what "the validator is worth it" means quantitatively.

- **ADR-C (Docs as Active Validator)** — **NEEDS-REWORK**. The structural insight (spec drift is a signal the existing `documented` gate misses) is correct and First-Principles-passable. But Expansionist's FAIL on `spec`-only scoping is correct — the ADR's own existence as an ADR (with MUST clauses for its own implementation) proves the abstraction needs `adr` from day 1. Rework: broaden Decision 4.2 to register `validator` metadata on ANY DocKind that opts in; remove the spec-only restriction. Tighten the `llmtxt.semanticDiff` dependency by adding contract tests against the editorial-vs-structural classifier. Add a saga-level phase Gantt that orders Phase C/D against ADR-A and ADR-B shipments.

- **ADR-D (CORE Tools First-Class)** — **REJECTED for this Saga**. This is the harshest call and the council stands behind it. ADR-D is a CORE refactor that legitimately belongs to T9831 SG-ARCH-SOLID, not to T10268 SG-IVTR-AUTONOMY. Two advisors (Contrarian, Outsider) caught that the ADR's load-bearing statistics (5,861 op-names, 616 envelopes) come from a different saga; Executor caught that the T10156 prerequisite is unverifiable; First Principles caught that the registry duplicates `defineCommand`. Even if every individual decision is good, this ADR is **out-of-saga**. Bundling a CLI/Studio/MCP/spawn-adapter refactor with the validator-loop change couples two huge migrations whose risk profiles are independent. Reject from this saga and re-file under T9831 with an explicit IVTR-feeding subset (only `validator.*`, `agent.request-hitl`, `worker.send-message`, `spawn.validator` need to ship for the validator loop to work — that's 4 tools, not 50).

### 3.2 Cross-cutting concerns

- **AC ID format is load-bearing for three ADRs.** ADR-A defines it. ADR-B's `AcFinding.acId` consumes it. ADR-C's front-matter `ac-bindings:` consumes it. ADR-D's `validator.ac-pull` consumes it. If ADR-A's dual-ID system is reworked, all three downstream ADRs need their string format updated. Treat ADR-A as the saga's critical path; no other ADR ships before it stabilises.

- **The Validator skill body is the silent prerequisite.** ADR-B asserts the skill ships "with the validator's `<role>`, `<philosophy>`, `<tool_strategy>`, `<output_formats>`, `<execution_flow>`, `<success_criteria>`" but never writes it. ADR-C assumes the Validator consumes `SpecValidator.validate`. ADR-D registers `validator.*` tools the Validator calls. None of them write the skill. Add E-IVTR-A5-VALIDATOR-SKILL as an explicit decomposition item — the skill IS the ADR-B deliverable, not a side effect.

- **Docs-provenance + AC-history collide.** ADR-A introduces `task_acceptance_criteria_history`. ADR-C relies on `docs_provenance` (ADR-078) for the "last published" SHA. The two history mechanisms are about to fight over the same query surface: "did this clause's bound code change relative to its last evidence binding?" Pick one history model (recommend: extend `docs_provenance` to absorb AC history, since docs is the canonical place for textual artefact lineage; treat AC text as a doc-typed projection).

- **Override surface is widening, not narrowing.** ADR-051 already has `CLEO_OWNER_OVERRIDE`. ADR-A adds `--ac-defer` and `--ac-rebind --confirm`. ADR-B adds `lead.escalate` → HITL takeover. ADR-C adds editorial-polish waivers via `<!-- editorial -->` markers. Net effect: 5+ override paths, each with its own audit channel. The owner's own constraint ("no rubber stamp") is at risk of being satisfied by ceremony rather than by structure. Council recommends: unify all override paths into a single `cleo override` verb that requires structured reason + writes to one audit log.

### 3.3 Prerequisites that MUST land before any of these ship

1. **T10156 reconciliation OR a real T10156 record.** ADR-D depends on it; the council could not verify the task exists. Either close the gap by filing T10156 anew or remove the prerequisite from ADR-D.
2. **Decomposition step (E-IVTR-A5) MUST include the Validator skill body as a first-class deliverable** — not as "follow-up."
3. **Cross-task `satisfies:` semantics** (currently DEFERRED in ADR-A § "Open questions") MUST be answered before ADR-B's `AcFinding.acId` shipping, because Epic-spanning evidence is normal not exceptional.
4. **Override-path unification design** — even a sketch — so the saga doesn't ship 5 new override entry points in 4 ADRs.

### 3.4 Highest-confidence steal

**GSD-2's `/gsd:verify-work` fresh-context Verifier sub-agent + model-tier table** (steal-table §2.3.1-2.3.4) is the strongest external grounding in the entire input set. It has three external corroborators (mindstudio, codecentric, Trilogy AI), it is already implemented in production at GSD-2, the cost-tier table (Opus planner / Sonnet executor / Sonnet verifier — or budget profile Sonnet / Sonnet / Haiku) gives ADR-B an immediately-usable defaults table that the ADR currently leaves unspecified. ADR-B should adopt the model-tier table by reference in D7.3, not just gesture at "validator SHOULD run on a different model family."

### 3.5 Riskiest assumption

**ADR-B's "fresh-context Validator measurably reduces false-positive rubber-stamping in CLEO."** This is borrowed from external systems' marketing. CLEO has no local measurement. The t9187 audit campaign (referenced in ADR-B §1.1) is the closest internal evidence and it's an inflammatory-anecdote corpus, not a controlled comparison. If the Validator adds 2-4x token cost and reduces false-positives by 5%, the ROI is negative. The saga should fund a one-week measurement spike against the t9187 corpus BEFORE Phase 1 opt-in flip. Currently no such measurement is planned.

### 3.6 Renumbering note

All four ADRs claim ADR-079 due to parallel authoring with no central allocator. The correct numbering (council declares but does not rename):
- **ADR-079** — AC Stable IDs (`adr-079-ac-stable-ids`) — earliest dependency
- **ADR-080** — Independent Validator (`adr-079-independent-validator` → ADR-080)
- **ADR-081** — Docs as Active Validator (`adr-079-docs-as-active-validator` → ADR-081)
- **ADR-082** — CORE Tools First-Class (`adr-079-core-tools-first-class` → ADR-082; downgrade to NEEDS-REFILE-UNDER-T9831 — number reserved if it ships as IVTR scope)

Rationale: ADR-A is the foundational atom; ADR-B is the consuming role; ADR-C is the consuming surface; ADR-D is the consuming infrastructure. The numbering order matches dependency order. Slugs should follow: `adr-079-ac-stable-ids`, `adr-080-independent-validator`, `adr-081-docs-active-validator`, `adr-082-core-tools-first-class`. Renaming is downstream cleanup and SHOULD happen in a single PR after the ADRs are accepted/reworked.

---

## 4. Action Items (for E-IVTR-A5 decomposition)

The decomposition step should reflect the following work-items derived from the verdicts above. ADR-D is excluded (rejected from this saga).

| # | ADR | Action item | Verdict driver |
|---|---|---|---|
| 1 | ADR-A | Replace dual-ID (positional + hash) with single canonical UUID + positional display alias | Contrarian, First Principles |
| 2 | ADR-A | Answer cross-task `satisfies:` binding (Epic-spanning evidence) before any sibling ADR consumes the format | Expansionist + Cross-cutting #1 |
| 3 | ADR-A | Add a "single new contributor walkthrough" doc to migration plan Step 7 — 7 concepts in one CLI call is too many without a guided ramp | Outsider |
| 4 | ADR-A | Ship the drizzle migration + dual-write schema in v+1 as drafted — Executor PASS | Executor |
| 5 | ADR-B | Ship `.cleo/skills/cleo-validator/SKILL.md` in the same PR as the contract — body required, not "follow-up" | Expansionist FAIL |
| 6 | ADR-B | Add infrastructure-fault rows to Max-N table (timeout, Conduit drop, validator-OOM) | Outsider |
| 7 | ADR-B | One-week measurement spike against t9187 corpus to establish baseline false-positive rate BEFORE Phase 1 opt-in | First Principles, Riskiest assumption |
| 8 | ADR-B | Adopt GSD-2 model-tier table verbatim in D7.3 defaults | Highest-confidence steal |
| 9 | ADR-B | Convert `lead-rollup.ts` `mode: 'active'` parameter to a feature flag with existing callers untouched | Executor |
| 10 | ADR-C | Broaden `validator` metadata to ANY DocKind that opts in — drop spec-only restriction | Expansionist FAIL |
| 11 | ADR-C | Contract-test `llmtxt.semanticDiff` editorial-vs-structural classifier; pin dep + monitor | Contrarian |
| 12 | ADR-C | Saga-level phase Gantt ordering Phase C/D against ADR-A and ADR-B | Executor |
| 13 | ADR-C | Three-audience separation (doc author / tool builder / validator agent) restructured into 3 clear sub-sections | Outsider |
| 14 | Saga | Verify or replace T10156 prerequisite reference | Executor on ADR-D |
| 15 | Saga | Unify override paths (`CLEO_OWNER_OVERRIDE`, `--ac-defer`, `lead.escalate`, editorial waiver) into one verb + one audit log | Cross-cutting concern #4 |
| 16 | Saga | Renumber ADRs 079→082 in dependency order; single PR | Renumbering note |
| 17 | Saga | Re-file ADR-D under T9831 SG-ARCH-SOLID with an IVTR-feeding subset (4 tools, not 50) — `validator.*`, `agent.request-hitl`, `worker.send-message`, `spawn.validator` | ADR-D REJECTED-from-saga |
| 18 | Saga | Decide history-model collision: `docs_provenance` absorbs AC history, OR `task_acceptance_criteria_history` is canonical | Cross-cutting #3 |

---

*End of council verdict.*
