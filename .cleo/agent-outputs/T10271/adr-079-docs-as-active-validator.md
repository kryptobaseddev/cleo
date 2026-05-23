# ADR-079 — `cleo docs` as Active Programmatic Validator

- **Status**: Proposed
- **Date**: 2026-05-23
- **Saga / Task**: T10268 (SG-IVTR-AUTONOMY) / T10271 (Wave 1 synthesis — IT-3 lane)
- **Predecessor canon**: ADR-076 (Canonical Docs SSoT), ADR-078 (Docs Provenance)
- **Predecessor sagas**: T9625 (SG-CLEO-DOCS-CANON — UX + SDK hardening), T9787 (SG-DOCS-CANON-CLOSURE — taxonomy + raw-md lockdown, both DONE)
- **Authors**: Wave-1 research agent (T10271)

> RFC 2119 keywords (MUST / SHOULD / MAY) are used throughout. They carry their
> standard interpretation EXCEPT where this document itself appears in the
> Validator pipeline as a spec — in which case the MUST clauses below are
> machine-extractable (see §4.3).

---

## 1. Context

### 1.1 What we built (T9625 + T9787)

The two prior sagas turned `cleo docs` into a working **passive SSoT** for
canonical project documentation:

- `.cleo/canon.yml` registers 9 DocKinds with `canonicalHome` (`ssot` |
  `ssot-first`), `publishMirror` (human-reviewable mirror), and CI-blocked
  `rawMdPaths` (audit doc §2.5; file `/mnt/projects/cleocode/.cleo/canon.yml`).
- `BUILTIN_DOC_KINDS` in `packages/contracts/src/docs-taxonomy.ts:119-204`
  mirrors `canon.yml` and adds `defaultOwnerKind`, `publishDir`,
  `requiresEntityId`, `entityIdPattern`. The `DocKindRegistry` class (`:303`)
  loads built-ins plus `.cleo/docs-config.json` extensions.
- 1,427 legacy markdown files were imported by T9791 into the attachment
  store; T9787 invariants I3 + I5 closed.
- `cleo check canon docs` blocks raw-fs writes to `rawMdPaths` where
  `rawMdAllowed: false` (audit doc §2.5; `packages/cleo/src/dispatch/
  domains/check.ts:550`).
- `packages/core/src/session/canon-lint.ts:1-100` runs *post-hoc* on session
  transcripts but does NOT block runtime ops.

### 1.2 What `cleo docs` does **not** do (today)

The audit (T10270, slug `ivtr-current-state-audit` §2.5, gap **G7**) is
unambiguous:

> *"`cleo docs` is a SSoT for storage, NOT a validator. `canon.yml` +
> `BUILTIN_DOC_KINDS` register WHERE docs live and which mirror dirs are
> CI-blocked. `cleo check canon docs` only blocks raw-fs writes; it does NOT
> consume the doc's content (e.g. spec body) to validate acceptance-gate
> satisfaction. There is NO programmatic hook of the form 'spec-doc-X must
> pass before gate-Y closes'."*

Consequently:

- An agent can attach a spec to a task and `cleo complete` it without anyone
  checking whether the implementation actually satisfies the spec's MUST
  clauses.
- A task can pass `documented` (atoms `[files]` or `[url]`) with a spec
  written *after* the implementation that conveniently describes whatever
  was built (post-hoc rationalisation).
- The MUST clauses themselves are inert prose. They are not indexed,
  numbered, or addressable from outside the document.

### 1.3 The owner's drift-detection goal

The Wave-1 brief states: *"If task T9614 has an attached spec doc, the
spec's RFC 2119 MUST clauses should map to AC IDs and the Validator should
check the spec's clauses against the implementation. Spec drift (spec says
X, code does Y) should be auto-detected."*

That is a different category of work from anything `cleo docs` does today.
It requires:

1. **Bindings**: a way for a spec to declare "clause §4.1 satisfies AC
   `T9614-ac3`".
2. **Extraction**: a primitive that pulls those bindings out of a doc and
   surfaces them as machine-addressable claims.
3. **Verification**: a Validator role that re-reads the spec on every
   verify cycle and cross-checks against the implementation (diff, tests,
   tool output).
4. **Drift detection**: a CI gate that flags when the implementation moves
   without the spec moving (or vice versa).

This ADR settles the six binding questions that gate that work.

### 1.4 Sibling work (this Saga)

Wave 1 of T10268 lands four parallel ADRs:

- **ADR-079 (this doc)** — Docs-as-active-validator (IT-3)
- ADR-080 — AC stable IDs (IT-1)
- ADR-081 — Independent Validator role (IT-2)
- ADR-082 — CORE tools / Category-A registry (IT-4)

This ADR depends on ADR-080 (stable AC IDs) and feeds ADR-081 (the Validator
that consumes spec clauses) and ADR-082 (the SDK primitive that exposes spec
extraction as a tool). It does NOT block them — the contracts proposed here
are additive.

---

## 2. Decision (Summary)

CLEO MUST extend `cleo docs` from a **passive SSoT** to an **active
programmatic validator** by adding:

1. **Front-matter `ac-bindings`** as the canonical doc↔AC binding mechanism;
   inline HTML-comment markers as a fallback (§4.1).
2. **Extending the `spec` DocKind with validator metadata** rather than
   introducing a new `validator-rule` DocKind (§4.2).
3. **A new `llmtxt`-backed primitive** `SpecClauseExtractor` (the workspace
   does NOT have an `llmtxt-core` workspace package — `llmtxt` is an
   external npm dep — so the primitive lives in
   `packages/core/src/docs/spec-extractor.ts` and uses the npm SDK's
   `getSection` + `validateContent`) (§4.3).
4. **A new `spec:<docSlug>#<clauseId>` evidence atom** that closes specific
   AC IDs (§4.4 + §4.5).
5. **A CI gate `cleo check spec-drift`** that runs `git diff` against
   bound code paths since the spec was last published; tasks where code
   changed but spec didn't (or vice versa) are flagged (§4.4).
6. **Backfill is opportunistic, not mandatory** — existing docs in the
   attachment store remain unchanged; new ADRs/specs that opt in get
   active enforcement; legacy docs can be retro-bound via
   `cleo docs bind` (§4.6).

The default is opt-in. No existing behaviour breaks.

---

## 3. Decision (Detailed)

### 3.1 Architectural posture

`cleo docs` MUST grow a thin validation layer that is:

- **Composable** — the new atom and the new CI gate plug into existing
  surfaces (`validateAtom` dispatch in `packages/core/src/tasks/
  evidence.ts:468-499`; `cleo check` subcommand surface).
- **Optional** — a spec without `ac-bindings` behaves exactly as today.
- **Cheap by default** — drift detection is a `git diff` + structural
  compare, not an LLM call.
- **Auditable** — every spec-driven verdict writes to
  `.cleo/audit/gates.jsonl` with the doc slug + clause id, so the
  Validator role (ADR-081) can be held to the same audit contract as
  evidence-atom verification.

### 3.2 Doc author burden ceiling

Authoring a binding MUST require ≤3 lines of front-matter for the simple
case (one spec → one AC) and ≤N+2 lines for N bindings. If the binding
cannot be expressed in front-matter (e.g. for an ADR with embedded code
that auto-generates bindings from `@spec` tags), inline markers MAY be
used as a fallback.

---

## 4. Sub-Decisions

### 4.1 Doc ↔ AC binding mechanism

**Decision.** Specs MUST declare bindings in YAML front-matter under
`ac-bindings:` as an array of `{ac, clause, kind?}` objects. Inline
HTML-comment markers (`<!-- ac:T9614-ac3 -->` preceding the clause) are
permitted as a fallback and MUST be honoured by the extractor.

Front-matter wire shape:

```yaml
---
slug: spec-t9614-pipeline
type: spec
task: T9614
ac-bindings:
  - ac: T9614-ac3
    clause: "§4.1"          # section anchor OR line range "L42-L58"
    kind: must               # must | should | may (RFC 2119)
  - ac: T9614-ac5
    clause: "§4.3.2"
---
```

**Validation rules** (enforced when the doc is `cleo docs add`-ed):

- `ac` MUST match `^T\d+-ac\d+$` (the stable AC ID format introduced by
  ADR-080). If ADR-080 has not shipped, the validator MUST accept any
  non-empty string and emit a SOFT warning.
- `clause` MUST resolve to a header anchor in the body (resolved via
  `llmtxt`'s `getSection`, `node_modules/llmtxt/dist/disclosure.d.ts`)
  OR a line-range token `L<start>-L<end>` that falls inside the body.
- `kind` defaults to `must`; non-`must` bindings MUST NOT count as
  hard atoms for the `documented` gate (see §4.4).

**Rationale.** Front-matter is the established CLEO convention (override-
cap waivers already use it — `packages/core/src/security/override-cap.ts:10`;
playbook definitions in `packages/contracts/src/operations/playbook.ts:87`).
Inline markers add resilience for tools that strip front-matter (e.g.
GitHub's markdown renderer) and let in-source documentation in TS files
(via `@spec` JSDoc) emit bindings without owning a separate doc file.

### 4.2 `canon.yml` extension

**Decision.** CLEO MUST extend the existing `spec` DocKind in
`packages/contracts/src/docs-taxonomy.ts` with optional validator metadata
rather than introducing a new `validator-rule` DocKind.

Schema diff against current `BUILTIN_DOC_KINDS` (file
`packages/contracts/src/docs-taxonomy.ts:119-204`):

```diff
   {
     kind: 'spec',
     label: 'Spec',
     description: 'Technical specification',
     defaultOwnerKind: 'task',
     publishDir: 'docs/spec',
     requiresEntityId: false,
+    validator: {                       // OPTIONAL — additive, additive only
+      mode: 'opt-in',                  // 'opt-in' | 'required' | 'off'
+      acBindingsField: 'ac-bindings',  // front-matter field name
+      driftCheck: true,                // run `cleo check spec-drift` on diff
+    },
   },
```

`ADR`, `research`, `plan`, `note`, `handoff` MAY also gain a `validator`
block in a follow-up; this ADR scopes the change to `spec` only.

A parallel addition to `.cleo/canon.yml`:

```diff
   spec:
     canonicalHome: ssot
     publishMirror: docs/spec/
     rawMdAllowed: false
+    validator:                         # OPTIONAL — present == active
+      mode: opt-in
+      driftCheck: true
```

**Why not a new `validator-rule` DocKind?** Three reasons:

1. **Taxonomy bloat.** The registry already has 10 kinds; adding an 11th
   that is "a spec but with extra rules" is the wrong abstraction —
   validation is an aspect, not a kind.
2. **Tooling reuse.** `cleo docs publish`, `cleo docs fetch`, mirror
   routing all already work for `spec`. A new kind requires duplicating
   the mirror dir, the slug pattern, and the import scanner.
3. **Author intent.** A doc that primarily exists to gate behaviour is
   still a spec — the validator metadata describes HOW it gates, not
   WHAT it is.

### 4.3 `llmtxt` SDK validator hook

**Reality check.** The brief asked whether `packages/llmtxt-core/` could
host the primitive. **It cannot** — the audit (§2.5) confirms no such
workspace package exists; `llmtxt` is an external npm dep at version
`2026.4.13` (`packages/core/package.json:411`). The dep DOES expose useful
primitives via `node_modules/llmtxt/dist/index.d.ts`:

- `getSection(content, anchor)` — pull a section by header anchor.
- `validateContent(content, opts)` / `validateText` / `autoValidate` —
  structural validation.
- `searchContent`, `detectDocumentFormat`, `generateOverview` — disclosure
  primitives.
- `semanticDiff`, `semanticConsensus` — content drift comparison.
- `LlmtxtDocument` — collaborative-document lifecycle.

**Decision.** A new SDK primitive `SpecClauseExtractor` MUST be added to
`packages/core/src/docs/spec-extractor.ts` (NEW FILE). It composes
existing `llmtxt` primitives plus a YAML front-matter parser; it does
NOT live inside `llmtxt` itself because RFC-2119-clause extraction is a
CLEO-specific concern that the upstream SDK should not own.

Proposed shape (contract only — implementation lives in a follow-up
task):

```ts
// packages/core/src/docs/spec-extractor.ts (NEW — DO NOT IMPLEMENT IN THIS PR)
import type { DocKindMetadata } from '@cleocode/contracts';
import { getSection, autoValidate } from 'llmtxt';

export interface SpecClause {
  /** Stable AC id (e.g. 'T9614-ac3'); from front-matter or inline marker. */
  readonly ac: string;
  /** Clause anchor — '§4.1' OR line range 'L42-L58'. */
  readonly clause: string;
  /** RFC 2119 strength of the clause. */
  readonly kind: 'must' | 'should' | 'may';
  /** Resolved body text of the clause (for `semanticDiff` drift compare). */
  readonly bodyText: string;
  /** SHA-256 of `bodyText` — drift detection key. */
  readonly bodySha256: string;
  /** Doc-level source pointer. */
  readonly source: { slug: string; docId: string; lineStart: number; lineEnd: number };
}

export interface SpecClauseExtractor {
  /**
   * Extract all AC bindings from a canonical spec doc.
   *
   * Resolution order:
   *  1. YAML front-matter `ac-bindings:` array (§4.1).
   *  2. Inline `<!-- ac:T###-acN -->` markers preceding RFC 2119 clauses.
   *  3. `@spec` JSDoc tags in companion `.ts` files (future — out of scope).
   *
   * The extractor MUST NOT call an LLM. All extraction is regex + YAML +
   * llmtxt's `getSection` resolution. Time budget: <50ms per spec.
   */
  extract(docSlug: string): Promise<SpecClause[]>;
}

export interface SpecValidator {
  /**
   * Given (taskId, acId), look up the bound clause, hash the bound code
   * region (via `task.files` + `validateCommit`'s diff machinery), and
   * return pass/fail.
   *
   * MUST return `pass: false` with `reason: 'spec-drift'` if the spec
   * clause's `bodySha256` has changed since the binding was published
   * AND the bound code path's commit-hash has NOT changed (or vice
   * versa). This is the asymmetric drift signal.
   */
  validate(taskId: string, acId: string): Promise<{ pass: boolean; reason?: string; clause?: SpecClause }>;
}
```

**Boundary registry.** Per Risk 6 in the audit (§5), the new interfaces
MUST register in `packages/contracts/src/boundary.ts` BOUNDARY_REGISTRY to
satisfy the T10176 CI gates.

### 4.4 Spec drift detection

**Decision.** A new CI gate `cleo check spec-drift` MUST be added that, for
every task with at least one bound `spec` doc:

1. Loads each `SpecClause` via `SpecClauseExtractor.extract`.
2. Resolves the clause's `bodySha256` from the attachment store at the
   commit the doc was last *published* (`docs_provenance` per ADR-078).
3. Resolves the file SHAs of `task.files` at HEAD.
4. Emits one of three verdicts per binding:
   - **GREEN** — both spec body and bound code unchanged since last
     publish OR both changed in the same commit (paired update).
   - **YELLOW** — spec body unchanged, code changed: agent updated
     impl without re-reviewing spec (advisory, soft warning).
   - **RED** — spec body changed, code unchanged since last verify:
     the spec was modified after the implementation was attested.
     This is the **structural drift** the owner is concerned about.

YELLOW MUST be reported but MUST NOT block the merge. RED MUST block the
`documented` gate and MUST require either:

- a paired re-verification (`cleo verify --gate documented --evidence
  "spec:<slug>#<clauseId>"`), OR
- an explicit drift waiver via `CLEO_OWNER_OVERRIDE` with reason.

**False-positive risk.** The biggest source of false RED is editorial
spec polish (e.g. clarifying a MUST clause without changing intent). To
mitigate, `semanticDiff` (from `llmtxt`, see §4.3) MUST be used as a
secondary filter: if `semanticDiff(oldBody, newBody).changes` contains
only `editorial`-classed changes (no MUST/SHOULD/MAY keyword flips, no
list-item additions), the verdict MUST be downgraded to YELLOW.

### 4.5 Spec-driven check vs. test-driven check

**Decision.** The two are NOT alternatives — they layer.

| Concern | Mechanism | Rationale |
|---|---|---|
| "Function `foo` returns `200`" | Test (existing `tool:test` atom) | Mechanically executable; tests are the cheapest grader |
| "Function `foo` MUST handle empty input per §4.1" | Spec atom (`spec:<slug>#§4.1`) + test (`tool:test`) | Spec atom proves the clause exists + binds to AC; test proves behaviour |
| "Architecture MUST keep CLI free of business logic" | Spec atom (no test possible) + lint rule | Declarative invariant; runtime verification impossible |
| "Documentation MUST exist" | Front-matter binding (`documented` gate) | Already covered by existing `files:` / `url:` atoms |
| "Subjective quality (UX is intuitive)" | NOT a spec atom — use Validator's LLM judge (ADR-081) | Doc-as-validator MUST NOT run an LLM grader; that is the Validator role's job |

**Rule (RFC 2119).** A gate MAY accept a `spec:` atom in addition to (or
instead of) its existing atoms when:

1. The spec clause is `kind: must`.
2. The clause's bound code region is non-empty.
3. The spec doc passed `cleo check spec-drift` at the current HEAD.

The `documented` gate's `GATE_EVIDENCE_MINIMUMS` set in
`packages/core/src/tasks/evidence.ts:114-154` MUST be extended to accept
`[spec]` as a fourth admissible atom set:

```diff
   documented: [
     ['files'],
     ['url'],
+    ['spec'],
   ],
```

The `implemented` gate MAY accept `[spec, commit]` as an additive set
(spec atom alone is insufficient — implementation evidence still
required). All other gates remain unchanged in this ADR (extension to
`qaPassed` for spec-driven lint rules is deferred to a follow-up).

### 4.6 Bootstrap / backfill

**Decision.** No mandatory backfill. Existing ~1,427 imported docs MUST
continue to work without bindings.

**Phased rollout:**

1. **Phase A — NEW SPECS** (single release after this ADR ships).
   New `cleo docs add --type spec` invocations MUST emit a warning when
   no `ac-bindings:` front-matter is present. The warning MUST NOT
   block. ADR-079 itself is the first dogfood target — this doc's own
   MUST clauses MUST be bindable.

2. **Phase B — RETRO BIND** (next release).
   A new verb `cleo docs bind <docSlug> --ac <acId> --clause <anchor>`
   MUST be added that updates the front-matter of an existing
   attachment in place (re-imports under a new content hash with
   provenance chain preserved per ADR-078). This unblocks retroactive
   bindings without forcing rewrites.

3. **Phase C — REQUIRED FOR T-CRITICAL** (release N+2).
   Tasks with `severity ∈ {P0, P1}` (Ed25519-attested per ADR-066) MUST
   have at least one bound spec doc for any `documented` gate close.
   Lower severities remain opt-in indefinitely.

4. **Phase D — DEFAULT-ON FOR NEW SPECS** (release N+3, only if Phase
   C false-positive rate <5%). The warning in Phase A becomes a hard
   error. Existing docs remain grandfathered.

**Bootstrap migration cost (audit-grounded).**

- Database: no schema migration. The binding lives in doc front-matter,
  which is already stored as raw bytes in the attachment store. No
  `tasks.db` change.
- Contracts: additive only — new optional `validator` field on
  `DocKindMetadata`, new atom kind `spec`, new SpecValidator interface.
- CLI: one new verb (`cleo docs bind`), one new check (`cleo check
  spec-drift`).
- Backfill effort: per-doc, opt-in. Owner can drive Phase B at their
  own pace.

---

## 5. Consequences

### 5.1 Positive

- **Spec drift becomes detectable, mechanically.** The current "spec is
  prose, code is reality, drift accumulates silently" failure mode
  closes for opt-in docs immediately and for P0/P1 critical paths in
  Phase C.
- **AC IDs gain a programmatic counterpart.** The work in ADR-080
  (stable AC IDs) becomes far more valuable: every AC ID can be the
  endpoint of a spec atom, not just a string in `task.acceptance_json`.
- **The Validator role (ADR-081) gains a deterministic source of
  truth.** Instead of re-deriving "did the worker satisfy the AC?"
  from prose, the Validator queries `SpecValidator.validate(taskId,
  acId)` and gets a binary verdict + drift signal.
- **Audit-log richness.** `gates.jsonl` entries become traceable to
  specific clauses; forensic review of *why* a gate closed becomes
  cheaper.

### 5.2 Negative

- **Doc-author burden.** Spec authors now write front-matter bindings.
  Mitigated by §3.2's 3-line floor and §4.6's opt-in default.
- **CI cost.** `cleo check spec-drift` adds one `git diff` per bound
  doc per CI run. Cheap (<200ms for a 50-clause spec on a small repo),
  but it adds up if every PR re-checks every spec.
- **False positives.** RED verdicts from editorial polish are the
  primary concern. Mitigation: `semanticDiff` filter (§4.4); per-clause
  waiver via inline marker (`<!-- ac:T9614-ac3 editorial -->`).
- **Coupling to `llmtxt` SDK semver.** `getSection` and `semanticDiff`
  are the load-bearing dependencies. If the upstream SDK breaks
  signatures, the validator breaks. Mitigation: pin the dep at the
  workspace level (existing practice) and write contract tests
  against the SDK surface.
- **Override expansion surface.** Yet another gate that can be
  bypassed via `CLEO_OWNER_OVERRIDE`. The audit (§1.1, gap G9) already
  flags 4 of 6 gates as override-bypassable; we are not making this
  worse, but we are also not closing it (that is ADR-081 territory).

### 5.3 Risk register

| Risk | Severity | Mitigation |
|---|---|---|
| Front-matter parse failures break `cleo docs add` for existing docs | HIGH | Parser MUST be permissive: missing/malformed `ac-bindings:` → ignore + soft warning; never throw at add time |
| `llmtxt` dep upgrade breaks `getSection` signature | MEDIUM | Pin dep at workspace level; contract tests around `SpecClauseExtractor` |
| Phase D rollout (default-on hard error) catches a wave of legacy specs | MEDIUM | Strict opt-in until Phase C metrics show <5% false-positive rate |
| Inline marker scan + YAML parse on every doc add adds latency | LOW | Cache parsed bindings by doc content hash; invalidate on attachment update |

---

## 6. Alternatives Considered

### 6.1 "Tests are sufficient — no spec atom needed"

The argument: every MUST clause should map to a test; if it can't, the
clause isn't testable and shouldn't gate anything.

**Rejected** because:

- Many architectural invariants (e.g. "CLI MUST NOT contain business
  logic", "doc files MUST live in `docs/spec/`") cannot be expressed as
  runtime tests but ARE the kind of thing a spec should govern.
- The owner's stated goal is drift detection, which is fundamentally a
  *spec vs. code* signal — tests don't surface it.
- ADR-051's atom grammar already accepts non-test atoms for `documented`
  (`files:`, `url:`); spec atoms are a structural sibling.

### 6.2 "LLM-judge per AC as the validator"

The argument: have a Validator agent (ADR-081) read the spec and the
diff every cycle and emit a verdict. No need for front-matter bindings.

**Rejected as primary mechanism**, accepted as fallback:

- LLM judges are non-deterministic, expensive, and not auditable in the
  same way `bodySha256` comparison is.
- The owner's `MUST detect drift` goal requires a stable invariant, not
  a probabilistic one.
- LLM judging IS in scope for the Validator role (ADR-081's territory)
  but it sits ABOVE the spec-atom layer — the spec atom answers "did
  the clause's bound code change?", the LLM judge answers "does the
  change still satisfy the clause's intent?".

### 6.3 "No formal binding — keep docs entirely passive"

The argument: drift detection is best left to humans during code
review; mechanising it adds tooling complexity for marginal benefit.

**Rejected** because:

- The audit (§1.2, gap G7) is unambiguous that the gap exists and is
  consequential.
- T9787 closed the SSoT lockdown side of canonical docs. Leaving the
  validation side unwired means the SSoT investment doesn't compound.
- The Wave-1 brief explicitly scopes "docs DRIVE validation" as the
  decision area for this ADR.

### 6.4 "New `validator-rule` DocKind (rejected in §4.2)"

Already covered. Spec is the right home; aspect-not-kind.

### 6.5 "Bindings live in a sidecar JSON file, not front-matter"

The argument: `<slug>.bindings.json` next to the doc keeps the doc
clean, no YAML parsing in the markdown body.

**Rejected** because:

- Two-file authorship is high friction; bindings drift from the doc.
- The attachment store stores ONE blob per doc; a sidecar means a
  second blob with manual ref-keeping.
- Front-matter is the established CLEO pattern (override-cap waivers,
  playbook YAML).

### 6.6 "Use `task.acceptance_json` to point AT the doc"

The argument: instead of the doc pointing at ACs, store
`acBoundDocs: [{slug, clause}]` on each AC.

**Rejected** because:

- Symmetric to current direction (doc → AC), but worse: docs become
  immutable, ACs become the mutable index, and updating a binding
  requires updating the task instead of the doc. The doc is the
  canonical artifact; bindings should live with it.
- ADR-080's stable AC IDs already give us a stable left-hand side;
  putting the binding on the doc lets the doc evolve without rewriting
  the AC array.

---

## 7. Migration Plan

1. **Land contracts** (this Saga / Wave 2).
   - Add optional `validator: { mode, acBindingsField, driftCheck }` to
     `DocKindMetadata`.
   - Register `SpecClauseExtractor` + `SpecValidator` interfaces in
     `packages/contracts/src/boundary.ts`.
   - Add `spec` atom kind to `ParsedAtom` union in
     `packages/core/src/tasks/evidence.ts:186-219` (parser-only; no
     validator wired yet).
2. **Implement extractor** (Wave 3 candidate task).
   - `packages/core/src/docs/spec-extractor.ts` — uses `llmtxt`'s
     `getSection` + a YAML parser + a regex for inline markers.
   - Unit tests against ADR-079 itself (this doc) as the dogfood
     corpus.
3. **Wire the atom validator** (Wave 3 candidate task).
   - `validateSpecAtom` in `evidence.ts` dispatch; resolves doc slug,
     loads clause, hashes body, hashes bound code path.
4. **Add `cleo docs bind`** (Wave 3 candidate task).
   - Mutates front-matter in place; preserves ADR-078 provenance chain.
5. **Add `cleo check spec-drift`** (Wave 4 candidate task).
   - CI gate; runs per-PR; consumes `SpecValidator.validate` per bound
     task.
6. **Phase A: warning on un-bound new specs** (release after wire-up).
7. **Phase B: retro-bind verb live** (next release).
8. **Phase C: required for P0/P1** (release N+2).
9. **Phase D: default-on for new specs** (release N+3, conditional on
   Phase C metrics).

Each phase is a separate Saga member task with its own AC gate. No
phase is irreversible — `validator.mode: 'off'` rolls back any
DocKind to passive behaviour.

---

## 8. References

### 8.1 Canon refs

- ADR-076 — Canonical Docs SSoT
  (`/mnt/projects/cleocode/.cleo/adrs/ADR-076-saga-first-class.md` —
  *note: collision with ADR-076 placeholder; verify final
  number at publish time*).
- ADR-078 — Docs Provenance
  (`/mnt/projects/cleocode/.cleo/adrs/ADR-078-docs-provenance.md`).
- ADR-051 — Evidence-based gate ritual (atom grammar).

### 8.2 Saga / task refs

- T9625 — `SG-CLEO-DOCS-CANON` (SSoT UX + llmtxt SDK).
- T9787 — `SG-DOCS-CANON-CLOSURE` (raw-md lockdown).
- T10268 — `SG-IVTR-AUTONOMY` (parent Saga).
- T10271 — Wave 1 ADR synthesis (this doc).
- T10269 — External steal table (slug `ivtr-external-systems-steal-
  table`).
- T10270 — Current-state audit (slug `ivtr-current-state-audit`).

### 8.3 Code refs (audit-grounded)

- Canon registry: `/mnt/projects/cleocode/.cleo/canon.yml`;
  `packages/contracts/src/docs-taxonomy.ts:119-204`.
- Doc storage primitives: `packages/core/src/docs/docs-ops.ts`;
  `packages/core/src/docs/import/attachment-store-accessor.ts`.
- Atom dispatch: `packages/core/src/tasks/evidence.ts:186-219`
  (`ParsedAtom` union), `:468-499` (validator dispatch),
  `:114-154` (`GATE_EVIDENCE_MINIMUMS`).
- Gate set entry: `packages/core/src/validation/engine-ops.ts:307-649`.
- Front-matter precedent: `packages/core/src/security/
  override-cap.ts:10`; `packages/contracts/src/operations/
  playbook.ts:87`.
- llmtxt SDK surface: `node_modules/llmtxt/dist/index.d.ts` (external
  npm dep `llmtxt@2026.4.13`); no `packages/llmtxt-core/` workspace
  package exists — confirmed by audit §2.5.
