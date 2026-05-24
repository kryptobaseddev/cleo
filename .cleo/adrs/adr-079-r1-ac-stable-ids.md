---
id: adr-079-r1-ac-stable-ids
tasks: [T10492]
kind: adr
status: Proposed
date: 2026-05-24
supersedes: ADR-079 (legacy stub — `adr-079-ac-stable-ids` from SG-IVTR-AUTONOMY Wave 1)
saga: T10377 (SG-IVTR-AC-BINDING)
epic: T10491 (E-ADR-A-REVISION)
decision: D013 (SG-IVTR-AC-BINDING routing)
summary: ADR-079-r1 — every Acceptance Criterion gets a single canonical UUIDv4 identity generated at AC creation, with a positional alias (AC1/AC2/...) used only for display. Replaces the dual positional+hash system the council §3.1 ruled over-engineered.
---

# ADR-079-r1: AC Stable IDs — Single Canonical UUID + Positional Alias

- **Status**: Proposed
- **Date**: 2026-05-24
- **Saga**: T10377 (SG-IVTR-AC-BINDING)
- **Epic**: T10491 (E-ADR-A-REVISION)
- **Decision**: D013 (Saga routing)
- **Supersedes**: legacy ADR-079 stub `adr-079-ac-stable-ids` (the Wave-1 SG-IVTR-AUTONOMY draft the council §3.1 marked NEEDS-REWORK)
- **Authors**: T10492 worker (cleo-prime / Cleo orchestrator persona)

## §1 Context

Every CLEO task carries one or more **Acceptance Criteria (ACs)** — short
testable statements that gate `cleo complete <id>`. Today ACs have no
stable identity. They live as ordered strings inside `tasks.acceptanceJson`,
addressed only by their position in that array. Two operational failures
follow from this:

1. **IVTR rubber-stamp gap (Saga T10377 root cause).** When a Validator
   agent reports "AC #2 not met", there is no canonical way to bind that
   verdict to a specific AC across re-runs. Reorder the AC list, edit one
   AC's text, or split one AC into two, and every prior verdict becomes
   ambiguous. The Validator role specified in sibling ADR (rework of
   ADR-079 "Independent Validator") is unimplementable without a stable
   handle for each AC.
2. **Cross-task `satisfies:` binding has nowhere to point.** Sibling
   specs in the saga (notably the `satisfies:<task-id>#<ac-id>` evidence
   atom in T10493) require an `<ac-id>` token that survives AC list
   mutations. Without it, the atom degrades into a positional pointer
   that silently re-aims at a different AC the moment the list is edited.

The Wave-1 SG-IVTR-AUTONOMY draft (the legacy `adr-079-ac-stable-ids` stub)
proposed a **dual-ID system**: every AC carries both a positional ID
(AC1/AC2/...) and a content-derived hash (`ac-h:<sha256>`). The Council
review (verdict §3.1, three advisors MODIFY, one PASS) found the dual
system over-engineered:

> "The core idea (per-AC stable IDs + `satisfies:` atom + AC-coverage
> check at complete) is sound and Executor-passable. But the dual-ID
> system (positional + hash) is over-engineered… Rework: pick ONE
> canonical ID (UUID-v4 at AC creation; positional alias for display),
> keep `_history` for drift detection. Also resolve cross-task binding
> (currently DEFERRED) before shipping."

This ADR is the council-driven rewrite. The four action items it closes
(per the saga decomposition plan `ivtr-decomposition-plan` §2.1):

- **#1** — Replace dual-ID with single canonical UUID + positional alias.
- **#2** — Answer cross-task `satisfies:` binding shape before any
  sibling ADR consumes the format.
- **#3** — Add new-contributor walkthrough to the migration plan (deferred
  to T10495 within the same Epic).
- **#18** — Decide the history-model collision (`docs_provenance` vs a
  separate `task_acceptance_criteria_history` table) — deferred to a
  saga-level spike but §2.3 of this ADR pins the contract the spike
  must honour.

## §2 Decision

### §2.1 Canonical AC identity: UUIDv4 at creation

Every AC gets exactly **one** canonical identifier: a **UUIDv4**
generated at the moment the AC is created (`cleo add --acceptance`,
`cleo task ac add`, or any other AC-mutating verb that introduces a new
clause). The UUIDv4 is the sole primary key for that AC across the
system. Persistence shape (binding to T10494's drizzle migration):

```ts
// packages/contracts/src/tasks/acceptance.ts
export interface AcceptanceCriterion {
  /** Canonical stable ID — UUIDv4, generated at creation, immutable. */
  id: string;
  /** Display text — editable; edits create a _history row but reuse `id`. */
  text: string;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /** ISO-8601 last-edit timestamp. */
  updatedAt: string;
  /** Owning task ID. */
  taskId: string;
  /** Monotonic creation order — see §2.2. */
  ordinal: number;
}
```

**Generation rule**: UUIDv4 via `crypto.randomUUID()` (Node 24 native).
No content-derived hash. No positional encoding. UUIDs are immutable
once written — edits to `text` reuse the same `id` and append a
`_history` row (§2.3).

**Why UUIDv4 and not the dual system**:

- UUIDv4 is collision-free across all CLEO projects without coordination
  — no central allocator, no sequence table, no need to read existing
  ACs before inserting a new one.
- A content hash conflates **identity** (which AC is this?) with
  **integrity** (has the text drifted?). The first is invariant by
  construction with a UUID; the second is the job of `_history` (§2.3).
- One canonical ID means one resolver, one index, one foreign-key
  target. Two IDs (positional + hash) double the resolution surface and
  force every consumer to pick a side per call site — exactly the
  over-engineering the council flagged.

### §2.2 Positional alias for display only

Humans read tasks as numbered lists ("AC1, AC2, AC3"). Agents read them
the same way in spawn-prompt output and `cleo show` envelopes. The
positional alias is therefore **kept** — but strictly as a derived
display label, never as a persistent identifier.

**Alias format**: `AC<ordinal>` where `<ordinal>` is a 1-based integer
derived from the AC's `ordinal` column, which is assigned by **insertion
order at creation** and **never reused**. If AC2 is deleted, future
ACs do not back-fill the gap — the surviving list renders as AC1, AC3,
AC4 (or, at the renderer's option, as AC1, AC2, AC3 with a "deleted"
audit note). The persistence layer NEVER renumbers — only the human
renderer chooses presentation.

**Resolution direction**:

- **AC creation**: UUIDv4 is generated AND an ordinal is assigned (max
  existing ordinal + 1 for this task). Both are written in the same
  transaction.
- **AC lookup**:
  - By UUIDv4 — direct primary-key fetch (canonical, always succeeds if
    the AC exists).
  - By alias `AC<n>` — secondary lookup against the (taskId, ordinal)
    composite index. Returns the AC whose ordinal matches `<n>`.
    Used ONLY by display renderers and the CLI's input-parsing layer.
- **Display**: every renderer emits `AC<ordinal>` as the primary visible
  label; the UUIDv4 is shown only in verbose / `--debug` modes and in
  envelope payloads consumed by agent tools.

**Why the alias survives at all**: human and agent prompt budgets matter.
A 36-char UUID in every spawn-prompt's AC list would bloat the
critical context window for every Worker, Validator, and Lead agent.
`AC1` / `AC2` keeps the prompt readable while `id: 8f4a…` lives in the
structured envelope for tools that need stable binding.

### §2.3 `_history` retention for drift detection

ACs are mutable — owners edit text to clarify scope, expand a clause,
or fix a typo. Without history, every edit silently invalidates prior
verdicts (the same drift class IVTR is designed to catch in code).

**Retention contract**:

1. Every UPDATE to an AC's `text` writes a row to
   `task_acceptance_criteria_history` BEFORE the live row mutates.
   Columns: `acId` (FK to canonical UUID), `taskId`, `previousText`,
   `previousUpdatedAt`, `changedAt`, `changedBy` (agent handle or
   `human:<email>`), `reason` (optional free text).
2. Every DELETE writes a final history row with a `deletedAt`
   timestamp; the live row is removed but the history chain remains
   queryable via the UUID.
3. `cleo show <taskId> --ac-history` renders the full chain per AC.
4. Validator verdicts pinned to a specific AC version reference
   `(acId, atVersion)` where `atVersion` is the `previousUpdatedAt`
   timestamp of the row used at verdict time. A drift check at
   `cleo verify` compares the live `updatedAt` to the verdict's
   `atVersion`; mismatch surfaces `W_AC_DRIFTED` with the diff.

**History-model collision deferral**: the saga decomposition plan §2.1
action #18 raised the question of whether AC history should live in a
new `task_acceptance_criteria_history` table OR be absorbed into the
existing `docs_provenance` graph. This ADR PINS the contract above
(`(acId, previousText, previousUpdatedAt, changedAt, changedBy,
reason)`) but leaves the **physical** storage decision to a saga-level
spike scheduled before T10494's drizzle migration lands. Whichever
table receives the rows, the contract above is non-negotiable —
agents and CI gates query via the contract, not the physical schema.

### §2.4 Cross-task `satisfies:` binding shape (basic shape only)

Sibling ADR `T10493` will finalise the full grammar. This ADR pins the
basic shape so downstream specs have something concrete to consume:

**Atom token**: `satisfies:<task-id>#<ac-id>`

- `<task-id>` — the standard CLEO `T####` token.
- `<ac-id>` — EITHER the canonical UUIDv4 OR the positional alias
  `AC<n>`. Aliases are resolved at evidence-collection time against
  the target task's current AC list; if the alias resolves to a
  DIFFERENT UUID than the one captured at atom-creation time, the
  evidence fails closed with `E_AC_ALIAS_DRIFTED` and the worker MUST
  re-state the atom using the canonical UUID.

**Examples**:

- Canonical (preferred for cross-task binding in long-lived specs):
  `satisfies:T10495#8f4a2c1e-b09d-4f6a-9c3e-7a1d4f8c0b2e`
- Display-convenient (preferred for within-task binding in fresh PRs
  where AC list is stable):
  `satisfies:T10495#AC2`

**Why allow both shapes**: pure-UUID atoms are bulletproof but unreadable
in PR diffs. Pure-alias atoms are readable but break under reorder.
Allowing both — with explicit failure-closed drift detection on the
alias path — gives authors the readable form by default and forces
canonical form only when the system detects drift. T10493 will pin
the full grammar (allowed escape characters, max length, validator
side-effects, AC-coverage gate semantics).

### §2.5 Out of scope (explicitly deferred)

- **Full grammar for `satisfies:` atom** — T10493 owns this. §2.4 is a
  basic shape contract, not the final grammar.
- **Drizzle migration** — T10494 owns the schema bootstrap, including
  resolving the §2.3 history-model collision.
- **New-contributor walkthrough** — T10495 owns the migration plan + ramp
  doc covering the 7-concept invocation path.
- **AC-coverage gate at `cleo complete`** — Wave 2 of the saga
  (`E-VALIDATOR-ROLE`) owns the Lead↔Worker MaxN loop that consumes
  these IDs.
- **CLI verbs** (`cleo task ac add|edit|delete|show|history`) — surface
  area landed alongside T10494 once the persistence shape is final.

## §3 Consequences

### §3.1 Positive

- **One canonical handle per AC** — Validator verdicts, `satisfies:`
  atoms, CI gates, and lead-rollup queries all share the same primary
  key. No translation layer.
- **Council action items #1 + #2 closed in one ADR** — exactly the
  scope the §3.1 verdict requested.
- **`_history` enables `W_AC_DRIFTED` warnings** without scope creep
  into the IVTR loop itself.
- **Alias-with-drift-detection** keeps PR diffs readable AND
  fail-closed under reorder.

### §3.2 Negative / costs

- **Storage**: one extra UUID column per AC, one extra ordinal column,
  one history table — manageable.
- **Migration friction**: existing tasks have N ACs as ordered strings
  with no IDs. T10494's migration MUST back-fill UUIDs in deterministic
  insertion order, write the first `_history` row per AC with
  `previousText = NULL`, and pin `ordinal = arrayIndex + 1`. The
  migration runs once per project at upgrade time.
- **Verdict invalidation on text edit**: this is the FEATURE, not a
  bug. Pre-IVTR verdicts pinned to a stale `atVersion` will surface
  drift warnings — that is precisely the rubber-stamp gap this saga
  exists to close.

### §3.3 Risks

- **Alias drift confusing authors** — mitigated by `E_AC_ALIAS_DRIFTED`
  error message including BOTH the original UUID the atom captured AND
  the current UUID at that alias position.
- **History bloat on noisy edits** — mitigated by `_history` rows
  carrying a `reason` column; renderers can group consecutive edits
  by the same author within a short window.
- **UUID readability in agent outputs** — mitigated by §2.2's alias
  display rule. Tools that emit raw payloads (debug envelopes, JSONL
  audit logs) carry the UUID; everything human-facing emits `AC<n>`.

## §4 Implementation Notes

These notes are non-normative pointers for the downstream tasks; the
authoritative scope of each task is in its own AC list.

### §4.1 For T10493 (`satisfies:` atom grammar)

Consume §2.4 verbatim as the BASIC shape. Define the FULL grammar
(escape chars, max length, validator side-effects, AC-coverage gate
semantics, interaction with the existing evidence atom grammar in
`packages/contracts/src/evidence.ts`).

### §4.2 For T10494 (drizzle migration)

Schema requirements derived from §2.1 + §2.3:

- `task_acceptance_criteria` table (replaces the JSON-array column):
  `id` (UUIDv4 PK), `taskId` (FK), `text`, `ordinal` (INT),
  `createdAt`, `updatedAt`.
- `task_acceptance_criteria_history` table OR equivalent absorption
  into `docs_provenance` (saga-level spike decides).
- Migration MUST back-fill UUIDs deterministically; existing
  `acceptanceJson` array order maps directly to ordinal.

### §4.3 For T10495 (new-contributor walkthrough)

Document the 7 concepts from §2 in the order a new contributor will
hit them: (1) AC has a UUID, (2) AC has an alias, (3) alias is for
display, (4) edits write history, (5) `satisfies:` atoms accept
both forms, (6) drift on alias fails closed, (7) `cleo show
--ac-history` is the audit surface.

### §4.4 Renaming chore (deferred)

The Wave-1 collision (four ADRs all claiming `ADR-079`) is closed by
this rewrite using the explicit `r1` suffix in slug
`adr-079-r1-ac-stable-ids`. The saga decomposition plan §5 also
proposed renumbering the sibling ADRs to 080/081/082 at saga
close-out (Wave 3, `E-IVTR-CLOSEOUT`). DO NOT renumber now — pre-
rework PRs are in flight on the sibling slugs.

---

*End of ADR-079-r1. Status: Proposed. Acceptance gates land in the
saga close-out. Cross-refs: D013 (saga routing), council verdict
§3.1, ivtr-decomposition-plan §2.1.*
