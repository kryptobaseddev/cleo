---
id: adr-081-satisfies-binding
tasks: [T10493, T10552]
kind: adr
status: Proposed
date: 2026-05-24
extends: adr-080-ac-stable-ids
supersedes: none
saga: T10377 (SG-IVTR-AC-BINDING)
epic: T10378 (E-ADR-B-REVISION)
decision: D013 (SG-IVTR-AC-BINDING routing)
council_action: "#2 (cross-task satisfies: binding grammar — prerequisite to every other ADR in the saga)"
summary: ADR-081 — full grammar for the `satisfies:<task-id>#<typed-ac-id>` evidence binding — ABNF, scope rules (same-saga), child_task semantics, evidence-bound AC binding rules, validator semantics, and rejection error codes — extending ADR-080's stable AC identity contract.
---

# ADR-081: Cross-task `satisfies:` Binding Grammar

## Status

Proposed

## Date

2026-05-24

## Metadata

- **Saga**: T10377 (SG-IVTR-AC-BINDING)
- **Epic**: T10378 (E-ADR-B-REVISION)
- **Decision**: D013 (Saga routing)
- **Extends**: `adr-080-ac-stable-ids` (§2.4 — basic atom shape; stable AC identity)
- **Authors**: T10493 worker (cleo-prime / Cleo orchestrator persona); T10552 amendment worker
- **Closes**: Council §3.1 action item #2

## Context

ADR-079-r1 §2.4 fixed the **basic shape** of the cross-task evidence atom:

```
satisfies:<task-id>#<typed-ac-id>
```

…and explicitly deferred the **full grammar** — escape characters, max
length, scope rules, validator side-effects, AC-coverage gate semantics,
and rejection error codes — to **this** ADR (T10493, amended by T10552).
ADR-080 then stabilized the target by giving every AC one canonical UUIDv4.
This amendment makes that UUID explicitly **typed** in the atom surface so
parsers never confuse an AC identity with a task ID, evidence ID, alias, or
opaque UUID from another domain. Council §3.1 action
item #2 declared the deferral a hard prerequisite: every other ADR in
SG-IVTR-AC-BINDING consumes this binding format, so no sibling ADR can
ship until the grammar is pinned.

The four sibling consumers that block on this ADR:

1. **`adr-079-r3-validator-role`** (Wave 2 of the saga, `E-VALIDATOR-ROLE`)
   — the Validator agent emits `satisfies:` atoms as its verdict surface.
   Without a grammar, two Validators running on the same task can emit
   atoms in different syntactic forms that the gate-checker cannot
   reconcile.
2. **`adr-079-r4-ac-coverage-gate`** (Wave 2) — gates `cleo complete <id>`
   on every AC having at least one accepted `satisfies:` atom. Requires
   a parse rule that the gate-checker can apply deterministically.
3. **`adr-079-r5-evidence-atom-extension`** (Wave 2) — extends
   `packages/contracts/src/evidence-atom-schema.ts` with a
   `satisfiesAtomSchema` Zod discriminator. Requires the canonical token
   shape, max length, and validator contract pinned here.
4. **`adr-079-r6-walkthrough`** (Wave 3, `E-IVTR-CLOSEOUT` via T10495)
   — the contributor walkthrough that documents the 7-concept invocation
   path. Cannot describe step (5) "`satisfies:` atoms accept both forms"
   without §3.1 below.

This ADR pins the contract those four consumers can build against
without further coordination.

## Decision

### §2.1 Formal grammar (ABNF — RFC 5234)

```abnf
; ──────────────────────────────────────────────────────────────────────
;  satisfies-atom — full grammar, RFC 5234 ABNF
; ──────────────────────────────────────────────────────────────────────

satisfies-atom  = "satisfies:" task-id "#" ac-ref [ "@" version-pin ]

task-id         = "T" 1*7DIGIT
                ; CLEO task ID surface form. Stored as INTEGER PK in the
                ; tasks table; serialised with the "T" prefix everywhere
                ; humans or atoms reference it. Max 7 digits accommodates
                ; the lifetime upper bound on CLEO task IDs.

ac-ref          = stable-ac-id / ac-alias

stable-ac-id    = "ac:" ac-uuid
                ; Normative stable AC identifier. The "ac:" type tag is
                ; part of the atom grammar, not decoration. It declares that
                ; the following UUID is an AcceptanceCriterion identity from
                ; ADR-080, preventing cross-domain UUID ambiguity. Persisted
                ; AC bindings MUST resolve and store this typed ID.

ac-uuid         = 8HEXDIG "-" 4HEXDIG "-" "4" 3HEXDIG "-"
                  ( "8" / "9" / "a" / "b" ) 3HEXDIG "-" 12HEXDIG
                ; Strict UUIDv4 grammar per RFC 9562 §5.4. Lowercase only
                ; in atom form — the canonical column casing is
                ; lowercase. Validators MUST reject mixed-case.

ac-alias        = "AC" 1*4DIGIT
                ; Human input alias per ADR-080 §2.2 — `AC<ordinal>`.
                ; Aliases are accepted only as a convenience at mint time;
                ; successful validation MUST immediately resolve them to a
                ; stable-ac-id (`ac:<uuid>`) and persist that typed ID.
                ; Max 4 digits caps the alias at AC9999 — well above any
                ; realistic per-task AC count and well below the integer
                ; ambiguity range.

version-pin     = 14DIGIT
                ; Optional ISO-8601-basic timestamp YYYYMMDDhhmmss pinning
                ; the AC's `updatedAt` at the moment the atom was minted.
                ; When present, the validator MUST compare against the
                ; live AC's `updatedAt` and surface W_AC_DRIFTED if they
                ; differ (see §3.4).

HEXDIG          = DIGIT / "a" / "b" / "c" / "d" / "e" / "f"
DIGIT           = %x30-39
```

**Worked examples** (all syntactically valid; semantics validated separately):

- `satisfies:T10495#ac:8f4a2c1e-b09d-4f6a-9c3e-7a1d4f8c0b2e` — typed
  stable AC ID form, no version pin (preferred for long-lived specs).
- `satisfies:T10495#AC2` — alias form (preferred in fresh PRs where the
  target task's AC list is stable).
- `satisfies:T10495#AC2@20260524223045` — alias form with version pin
  (Validator emissions where pin-on-mint is required by §3.4).
- `satisfies:T10495#ac:8f4a2c1e-b09d-4f6a-9c3e-7a1d4f8c0b2e@20260524223045`
  — typed stable AC ID + version pin (highest-trust form; Validator's
  preferred emission).

### §2.2 Lexical limits

| Limit | Value | Rationale |
|---|---|---|
| Max atom length | **120 chars** | Longest legal form is 81 chars (`satisfies:` + `T` + 7-digit + `#` + `ac:` + 36-char UUID + `@` + 14-digit) — round up to 120 to leave headroom for one future suffix without grammar bump. |
| Max task-id digits | **7** | Caps at `T9999999` — three orders of magnitude above current CLEO task IDs (~T10500 as of 2026-05-24). |
| Max ac-alias digits | **4** | Caps at `AC9999` — three orders of magnitude above realistic per-task AC count. |
| UUID case | **lowercase** | Matches the canonical column casing per ADR-080 §2.1. Validators MUST reject mixed-case to prevent silent dedupe failures. |
| Escape characters | **NONE** | No quoting, no URL-encoding, no `\` escapes. The grammar is a bounded fixed-shape token — escapes would expand the parse surface for zero functional gain. |

### §2.3 Scope rule: **SAME SAGA**

A `satisfies:<task-id>#<typed-ac-id>` atom on task **A** MAY reference an AC on
task **B** if and only if **A and B are members of the same Saga (SG-)
or the same root Epic when no Saga is present.**

**Membership resolution** (deterministic, no fuzzy matching):

1. Resolve A's saga via `tasks.saga_id` (column added by T10494). If
   non-null, the binding's scope set is `{ tasks WHERE saga_id = A.saga_id }`.
2. If A has no saga, resolve A's root epic by walking `parent_id`
   ancestors until `type='epic' AND parent_id IS NULL`. The scope set is
   `{ A.root_epic } ∪ { tasks transitively under A.root_epic }`.
3. If B ∉ scope set, the binding is **out of scope** and the validator
   MUST fail closed with `E_AC_BINDING_OUT_OF_SCOPE` (see §3.3).

**Rationale for SAME SAGA (not unrestricted, not same-epic-only)**:

- **Why not unrestricted?** Cross-saga bindings invite tight coupling
  between independent shipping units. Saga A can ship and be archived
  long before Saga B starts; an atom on a B task pointing at an
  archived A task creates a "satisfied by ghost" pattern the gate-checker
  cannot validate. Worse, sagas are the unit of release-narrative
  ownership (see ADR-073 §1.1); cross-saga binding silently couples
  release narratives across owners.
- **Why not same-epic-only?** The saga is the unit of coherent
  cross-epic work — that is exactly the design pillar of ADR-073's
  Saga tier. Restricting to same-epic would prevent legitimate
  cross-epic atoms within one saga (e.g. a Wave-3 closeout task
  satisfying ACs on the Wave-1 foundation task in the same saga).
- **Why same-saga is the right middle?** Sagas have lifetime bounds
  (open → shipping → archived) that match the lifetime of a meaningful
  cross-task binding. The scope set is bounded, queryable, and
  archivable as a unit. Council §3.1 routed this saga specifically to
  pin the saga boundary as the binding boundary.

### §2.4 Validator semantics — `cleo verify --evidence "satisfies:..."`

The runtime validator (extension of
`packages/core/src/tasks/evidence.ts`) accepts a `satisfies:` atom IFF
**all five** of the following conditions hold; otherwise it rejects with
the error code in §3.3 corresponding to the first failed check.

| # | Check | Failure code |
|---|---|---|
| 1 | `<task-id>` parses as a valid CLEO task ID per §2.1 ABNF | `E_AC_BINDING_MALFORMED` |
| 2 | The target task exists in the local `tasks` table | `E_AC_BINDING_TARGET_NOT_FOUND` |
| 3 | The target task's status ∈ `{pending, active, done}` (NOT `{cancelled, archived, deleted}`) | `E_AC_BINDING_TARGET_TERMINAL` |
| 4 | The AC referenced by `<ac-ref>` exists on the target task — either by direct typed stable ID lookup (`ac:<uuid>`) OR by `(task_id, ordinal)` composite lookup when `<ac-ref>` is an alias | `E_AC_BINDING_TARGET_AC_NOT_FOUND` |
| 5 | The source task (the one bearing the atom) and the target task share a saga (or root epic when no saga) per §2.3 | `E_AC_BINDING_OUT_OF_SCOPE` |

**Side effects on accept**:

- The validator writes a row to `evidence_satisfies_bindings`
  (table introduced by T10494's drizzle migration) with columns:
  `source_task_id`, `target_task_id`, `target_ac_uuid` (always the
  resolved canonical UUID, regardless of which form the atom used),
  `target_ac_typed_id` (always `ac:<target_ac_uuid>`),
  `target_ac_alias_at_mint` (the alias form when present, else NULL),
  `version_pin` (the optional `@<ts>` payload when present, else NULL),
  `evidence_atom_id`, `evidence_atom_hash`, `evidence_uri`, `created_at`.
  The row is append-only.
- If the atom carried an alias AND the alias resolves to a UUID that
  differs from one previously seen for the same `(source_task_id,
  target_task_id, target_ac_alias_at_mint)` triple, the validator
  surfaces a non-fatal `W_AC_ALIAS_DRIFTED` warning (NOT an error) —
  the binding is accepted because the AC-coverage gate runs on the
  canonical UUID, but the author is told their alias has shifted.

**Side effects on reject**: the atom is dropped, the rejection code is
returned in the envelope, no rows are written.

### §2.5 Evidence-bound AC binding rules

A `satisfies:` atom is a **binding attached to evidence**, not evidence by
itself. Validators MUST NOT accept or persist an unbound assertion such as
"this task satisfies AC2" without a concrete evidence carrier.

Normative binding rules:

1. Every accepted binding MUST reference exactly one evidence carrier via
   `evidence_atom_id` OR the pair (`evidence_atom_hash`, `evidence_uri`).
   The carrier may be a test run, commit, PR, artifact path, transcript, or
   signed Validator verdict already accepted by the evidence subsystem.
2. The binding inherits the carrier's trust state. If the carrier is later
   revoked, superseded, unreachable, or fails integrity verification, the
   binding becomes non-covering until re-validated against a live carrier.
3. The persisted AC side of the binding is always typed and canonical:
   `target_ac_typed_id = "ac:" || target_ac_uuid`. Alias text is retained
   only as mint-time audit context and MUST NOT be used for coverage.
4. A single evidence carrier MAY bind multiple ACs only by emitting one
   accepted `satisfies:` atom per target AC. There is no wildcard, range, or
   task-level blanket satisfaction form.
5. A binding is immutable after acceptance. Corrections append a new binding
   row and optionally mark the old evidence carrier superseded; they never
   rewrite the original row.

### §2.6 Child-task satisfaction semantics and AC-coverage gate contract

This ADR pins the binding grammar and the contract the AC-coverage gate will
consume:

- A child task contributes to a parent task's AC coverage only when the
  parent has an explicit containment edge to that child (`relation_type =
  'child_task'` or the canonical parent_id containment edge after ADR-073's
  amendment) and the child task itself is not terminal-failed (`cancelled`,
  `archived`, `deleted`).
- A child task's **done** status is not sufficient by itself. The child must
  carry accepted, evidence-bound `satisfies:` bindings that target the
  parent's typed AC IDs. Completion state is a prerequisite signal; the
  binding rows are the coverage source of truth.
- Parent AC coverage is monotonic per accepted evidence carrier: if child C
  binds evidence E to parent AC `ac:<uuid>`, parent P is covered for that AC
  while E remains valid, even if sibling child D also binds the same AC. The
  gate deduplicates by (`target_task_id`, `target_ac_typed_id`) and reports
  all contributing children for audit.
- The gate queries `evidence_satisfies_bindings WHERE source_task_id IN
  (this task OR any eligible child_task descendant)` and groups by
  `target_ac_typed_id`.
- An AC is "covered" IFF at least one row exists with
  `target_ac_typed_id = 'ac:' || ac.id`, the row is evidence-bound per §2.5,
  the evidence carrier is currently valid, AND no later `W_AC_DRIFTED`
  warning has been raised for that binding without subsequent re-validation.
- The gate does NOT consider the alias form — only the canonical UUID
  resolution captured in the typed stable AC ID at validator-accept time.
  This is what makes alias drift safe: even if the alias renumbers, the gate
  keeps pointing at the AC the author originally meant.

## §3 Error codes (normative — exported from `@cleocode/contracts`)

All codes follow the existing `E_<DOMAIN>_<REASON>` and `W_<DOMAIN>_<REASON>`
conventions. They will be exported from
`packages/contracts/src/errors.ts` by the T10494 migration PR (the
contract is pinned here so consumers can `import { ... } from
'@cleocode/contracts'` against a known surface).

| Code | Severity | Surface | Meaning |
|---|---|---|---|
| `E_AC_BINDING_MALFORMED` | error | atom parse | The atom does not match the §2.1 ABNF. |
| `E_AC_BINDING_TARGET_NOT_FOUND` | error | validator §2.4#2 | The `<task-id>` does not exist in the local `tasks` table. |
| `E_AC_BINDING_TARGET_TERMINAL` | error | validator §2.4#3 | The target task is in a terminal state (`cancelled`, `archived`, `deleted`). |
| `E_AC_BINDING_TARGET_AC_NOT_FOUND` | error | validator §2.4#4 | The `<ac-ref>` does not resolve to any AC on the target task (neither by typed stable ID nor by `(task_id, ordinal)` alias lookup). |
| `E_AC_BINDING_OUT_OF_SCOPE` | error | validator §2.4#5 | Source and target tasks are not members of the same saga (or root epic when no saga). |
| `E_AC_ALIAS_DRIFTED` | error | atom mint | The alias the atom captured at mint resolves to a different UUID at verify time — promoted to ERROR per ADR-080 §2.4 ("fails closed"). The worker MUST re-state the atom using the typed stable AC ID. |
| `W_AC_ALIAS_DRIFTED` | warning | validator §2.4 side-effect | Same condition as `E_AC_ALIAS_DRIFTED` but surfaced as a warning when the binding was previously accepted under the old UUID — gives the author a chance to update before the next verify. |
| `W_AC_DRIFTED` | warning | AC-coverage gate (forward) | The target AC's text has been edited since this binding was created; the binding is still valid but the human author should review. Consumed by `adr-079-r4-ac-coverage-gate`. |

**Why `E_AC_ALIAS_DRIFTED` AND `W_AC_ALIAS_DRIFTED`**: ADR-080 §2.4
declared alias drift "fails closed" — that is the **error** form at
verify time. The **warning** form catches the slow drift case where the
binding was accepted yesterday under alias `AC2 → UUID-A`, but today
`AC2 → UUID-B`; the previously-accepted row in
`evidence_satisfies_bindings` still resolves to UUID-A so the gate
still passes, but the author sees a warning that their next emission
will fail closed unless they switch to canonical UUID form.

## Consequences

### §4.1 Positive

- **Council §3.1 action #2 closed in one ADR.** No other sibling ADR in
  SG-IVTR-AC-BINDING is blocked on grammar uncertainty.
- **Bounded grammar.** ABNF parse complexity is O(1) per atom; no
  recursion, no escapes, no quoting. The runtime parser can reject
  malformed atoms in a single regex pass.
- **Same-saga scope is queryable.** The scope check is a single
  indexed lookup (`tasks.saga_id` after T10494) — no recursive parent
  walk in the hot path.
- **Alias drift fails closed with diagnostic warning.** Authors get
  one warning cycle before hard failure — the rubber-stamp gap the
  saga exists to close stays closed even under heavy AC list mutation.
- **Validator side-effect table feeds the future AC-coverage gate
  without re-parsing atoms.** The gate (Wave 2) queries one indexed
  row per binding instead of re-walking the evidence string history.

### §4.2 Negative / costs

- **One extra table** (`evidence_satisfies_bindings`). 7 columns,
  append-only, indexed on `(source_task_id, target_task_id)` and
  `target_ac_typed_id`. T10494 owns the migration.
- **Same-saga scope means cross-saga workflows need explicit Lead
  coordination.** A task that genuinely needs to satisfy an AC outside
  its saga must escalate to the Lead, who can extend the source task's
  saga membership (rare — by design).
- **Version-pin format `@YYYYMMDDhhmmss` is a 14-char addition** to
  the atom. Authors who don't need pin precision can omit it; the
  Validator emits it because pin-on-mint is its trust surface.

### §4.3 Risks

- **Authors confused by UUID vs alias.** Mitigated by §3.3 error
  messages that include BOTH the captured form AND the canonical
  UUID, and by ADR-079-r3-walkthrough step (5) ("both forms accepted,
  alias is friendly, canonical is bulletproof").
- **Same-saga scope feels restrictive to authors new to CLEO.**
  Mitigated by the walkthrough explaining sagas as release narratives;
  the restriction maps cleanly to "tasks that ship together can
  reference each other."
- **`evidence_satisfies_bindings` table growth.** Append-only and
  per-binding (not per-verify) — growth rate matches saga throughput,
  not verify throughput. Estimated O(1000 rows/year/active saga).

## §5 Implementation Notes (non-normative)

### §5.1 For T10494 (drizzle migration)

Add three columns and one table per §2 + §3:

1. `tasks.saga_id` (TEXT NULL, FK to tasks.id where label='saga')
   — required for §2.3 scope resolution.
2. `evidence_satisfies_bindings` table per §2.4 side-effect contract.
3. Indexes:
   - `evidence_satisfies_bindings (source_task_id, target_task_id)`
   - `evidence_satisfies_bindings (target_ac_typed_id)`
   - `tasks (saga_id) WHERE saga_id IS NOT NULL` (partial index)

### §5.2 For `adr-079-r5-evidence-atom-extension`

Extend `packages/contracts/src/evidence-atom-schema.ts`:

```ts
export const satisfiesAtomSchema = z.object({
  kind: z.literal('satisfies'),
  taskId: z.string().regex(/^T[0-9]{1,7}$/),
  acRef: z.union([
    z.string().regex(/^ac:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
    z.string().regex(/^AC[0-9]{1,4}$/),
  ]),
  versionPin: z.string().regex(/^[0-9]{14}$/).optional(),
});
```

Add `satisfiesAtomSchema` to the `EvidenceAtomSchema` discriminated
union. Add a runtime validator in `packages/core/src/tasks/evidence.ts`
that implements §2.4's five checks in order, returning the first
failure code.

### §5.3 For Wave 2 (`E-VALIDATOR-ROLE`)

The Validator agent emits atoms in the **canonical + version-pin** form
(`satisfies:T#####` + `#ac:<uuid>@<ts>`, e.g. `satisfies:T10495#ac:<uuid>@<ts>`) for highest trust. Worker agents may
emit either form in PR bodies; the migration walkthrough (T10495)
explains why the canonical form is preferred for any binding expected
to outlive the immediate PR cycle.

### §5.4 Out of scope (explicitly deferred)

- **AC-coverage gate at `cleo complete`** — owned by
  `adr-079-r4-ac-coverage-gate` (Wave 2). §2.5 pins the contract that
  gate will consume.
- **CLI verbs** (`cleo task ac add|edit|delete|show|history`) — surface
  area landed alongside T10494 once the persistence shape is final.
- **Cross-saga escape hatch** — explicitly OUT OF SCOPE. If the saga
  boundary proves too restrictive in practice, file a follow-up ADR
  proposing a `satisfies:!<task-id>#<typed-ac-id>` "forced binding" form
  with explicit Lead approval. NOT in this ADR.

---

*End of ADR-079-r2. Status: Proposed. Acceptance gates land in the
saga close-out. Cross-refs: ADR-079-r1 §2.4 (basic shape this ADR
extends), D013 (saga routing), council verdict §3.1 action #2,
ivtr-decomposition-plan §2.1.*
