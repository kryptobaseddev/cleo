# T11676 — ADR Cross-Store Reconciliation Plan

**Generated:** 2026-06-05 · READ-ONLY analysis · NOTHING IN THIS PLAN HAS BEEN EXECUTED.
**Grounded in:** `adr-cross-store-identity-map` (T11191) + ratified `docs-ssot-vault-reconciliation` policy.
**Scope:** the 11 divergent ADR numbers — 051(×3), 052, 053, 054, 068(×3), 070, 072, 078, 079, 086, 088.

## Locked policy (NOT re-litigated)

1. **SLUG-PRIMARY** — the kebab slug is the canonical handle. ADR numbers are display aliases only. NEVER renumber a slug to resolve a collision; resolve collisions by content-review + (for true dups) supersession. New display aliases come from next-free numbers, no reuse.
2. **cleo.db `docs_*` is the SOLE authority.** `.cleo/adrs/*.md` and `docs/adr/*.md` on disk are DERIVED projections; cleo.db wins on drift.

## Decisive finding that reframes the task

The collisions are **NOT drifted copies of one ADR.** Every shared number maps to **distinct decisions with distinct titles** (see table). And critically:

**21 of the 25 divergent files are NOT in cleo.db (the SSoT) at all** — they live only on disk in `.cleo/adrs/` (legacy authoritative store) and `docs/adr/`. Only 4 distinct contents are in the SSoT today: `ADR-078-docs-provenance` (sha `28fcc3e4`), `adr-boundary-registry` (sha `0866e1c7`, = docs/adr ADR-078-boundary-registry — present TWICE as duplicate rows), `adr-086-cli-output-contract-e9` (sha `31398d1e`), plus the already-renamed `adr-080`/`adr-081`/`adr-082`.

Therefore the reconciliation is mostly **INGEST disk-only distinct decisions into the SSoT and assign each a unique display alias** — not supersede-the-loser dedup. The only true dedup is the duplicate `adr-boundary-registry` rows; the only sanctioned deletes are the two `adr-079-r1/r2` forwarding stubs.

## Next-free display-alias pool

Confirmed ground truth across both stores + db: only gaps are **040, 060**; max occupied = **089** (083–089 all distinct live ADRs). So next-free pool, in order: **040, 060, 090, 091, 092, 093, …**.

> ⚠️ **ADR-090 is RESERVED** by policy for the slug-primary ADR (T11193, per reconciliation doc §5). Do NOT consume 090 for an alias without owner confirmation — see OPEN QUESTIONS.

## (a) Disposition TABLE

Legend: store `A`=`.cleo/adrs/`, `D`=`docs/adr/`, `DB`=cleo.db SSoT. sha = first 12.

| # | distinct docs + store | same/different | action | canonical slug (handle) | stale copies to drop |
|---|---|---|---|---|
| **051** | `ADR-051-override-patterns` (A, cca796c2) · `ADR-051-programmatic-gate-integrity` (A, 88fef39a) · `ADR-051-worktree-extension` (A, 6a63832c) | **3 DIFFERENT decisions** (override patterns ≠ gate integrity ≠ worktree evidence ext) | KEEP ALL 3; ingest each to SSoT; assign distinct display aliases | `adr-051-programmatic-gate-integrity` keeps 051; `adr-051-override-patterns`→**040**; `adr-051-worktree-extension`→**060** *(provisional, owner-confirm which keeps 051 — see OQ-1)* | none (no dup content) |
| **052** | `ADR-052-caamp-keeps-commander` (A, 87e6300f) · `ADR-052-sdk-consolidation` (A, 8572746e) | **2 DIFFERENT** | KEEP BOTH; ingest both | `adr-052-sdk-consolidation` keeps 052; `adr-052-caamp-keeps-commander`→**090** *(provisional, OQ-2)* | none |
| **053** | `ADR-053-playbook-runtime` (A, 5fde3e69) · `ADR-053-project-agnostic-release-pipeline` (A, 1a4f4c4c) | **2 DIFFERENT** | KEEP BOTH; ingest both | `adr-053-playbook-runtime` keeps 053; `adr-053-project-agnostic-release-pipeline`→next-free | none |
| **054** | `ADR-054-manifest-unification` (A, a0580cef) · `ADR-054-migration-system-hybrid-path-a-plus` (A, 9865ec17) | **2 DIFFERENT** | KEEP BOTH; ingest both | `adr-054-migration-system-hybrid-path-a-plus` keeps 054; `adr-054-manifest-unification`→next-free | none |
| **068** | `ADR-068-canonical-agent-system` (A, 90c07fc9) · `ADR-068-cleo-database-charter` (A, 0b57a475) · `ADR-068-per-worktree-handoff` (D, 71e12a3e) | **3 DIFFERENT** | KEEP ALL 3; ingest all 3 | `adr-068-cleo-database-charter` keeps 068 *(it is the canon cited in AGENTS.md)*; other two→next-free | none |
| **070** | `ADR-070-three-tier-orchestration` (A, 0e43735c) · `ADR-070-verifier-backed-ac-auditor-loop` (A, 1a995876) | **2 DIFFERENT** | KEEP BOTH; ingest both | `adr-070-three-tier-orchestration` keeps 070; other→next-free | none |
| **072** | `ADR-072-unified-llm-provider-architecture` (A, c28ec017, frontmatter id=ADR-072) · `ADR-072-nexus-db-split` (D, c8cc2b60) | **2 DIFFERENT** | KEEP BOTH; ingest both | `adr-072-unified-llm-provider-architecture` keeps 072 (declares id ADR-072); `adr-072-nexus-db-split`→next-free | none |
| **078** | `ADR-078-docs-provenance` (A+**DB** 28fcc3e4) · `ADR-078-boundary-registry` (D, 0866e1c7 = **DB** slug `adr-boundary-registry`, **2 dup rows**) | **2 DIFFERENT** | KEEP BOTH (both already in SSoT); assign aliases; **dedup the 2 boundary-registry rows** | `adr-078-docs-provenance` keeps 078; `adr-boundary-registry`→next-free | **1 duplicate cleo.db row** of `adr-boundary-registry` (same sha 0866e1c7, owners T10176 & T10223) |
| **079** | `ADR-079-docs-sdk-boundary-contract` (A, 0113f7f7) · `adr-079-r1-ac-stable-ids` (A, 1a545ec6 — STUB) · `adr-079-r2-satisfies-binding` (A, 0fa5e68f — STUB) · `adr-079-r2-satisfies-binding` (**DB**, 81ef246e — pre-rename FULL body, status Proposed) | r1/r2 = **TOMBSTONE forwarding stubs**; the `-079-docs-sdk-boundary-contract` is a real ADR; the DB r2 blob = stale pre-rename content of the now-canonical `adr-081` | ingest `adr-079-docs-sdk-boundary-contract`; **DELETE r1/r2 disk stubs**; **supersede the stale DB r2 blob → `adr-081-satisfies-binding`** | `adr-079-docs-sdk-boundary-contract` keeps 079 | **DELETE** disk `adr-079-r1-ac-stable-ids.md` + `adr-079-r2-satisfies-binding.md`; **retire** stale DB blob `81ef246e` (superseded by adr-081 65→44c9f737/44c9f737) |
| **086** | `ADR-086-cli-output-contract-e9` (A+**DB** 31398d1e) · `ADR-086-nested-nexus-disposition` (D, 55d8ab46) | **2 DIFFERENT** | KEEP BOTH; ingest the disk-only one | `adr-086-cli-output-contract-e9` keeps 086 (canon cited in AGENTS.md, already SSoT); `adr-086-nested-nexus-disposition`→next-free | none |
| **088** | `ADR-088-pm-core-v2-workgraph-relations-completion-criteria` (D, 28495951) · `ADR-088-release-pipeline-coherence` (D, 741bca80 — **content titles itself "ADR-087"**) | **2 DIFFERENT** + **MISLABEL** | KEEP BOTH; ingest both. `…-pm-core-v2…` keeps 088. `…-release-pipeline-coherence` content claims 087 but **087 is already taken** by `ADR-087-worktree-ffi-topology` → CANNOT reclaim 087 → assign next-free | `adr-pm-core-v2-workgraph-relations-completion` (= db slug, already SSoT) keeps 088; `adr-088-release-pipeline-coherence`→next-free *(OQ-3)* | none |

Totals: **MERGE/supersede = 2** (1 dup `adr-boundary-registry` row + 1 stale DB `adr-079-r2` blob→adr-081) · **KEEP-BOTH + alias = 19 distinct decisions** across 9 numbers · **DELETE = 2** (079-r1/r2 disk stubs).

## (b) Proposed ORDERED `cleo docs` operations — ⛔ NOT-EXECUTED (proposal only)

> These are the operations the IMPLEMENTATION step (a separate, gated task) WOULD run. None were run in this analysis. Exact slugs/aliases for the "→next-free" rows are pending the OPEN QUESTIONS owner decisions; placeholders below use the provisional pool 040/060/090/091/… in number-then-file order.

**Phase 1 — INGEST disk-only distinct decisions into the SSoT** (`cleo docs add`, type=adr). Each keeps its slug; display-alias number set via the slug-aware numbering surface (T10159 `numbering.ts`) at ingest:

```
# (slug-primary; number = display alias only)
cleo docs add T<owner> .cleo/adrs/ADR-051-override-patterns.md            --type adr --slug adr-051-override-patterns
cleo docs add T<owner> .cleo/adrs/ADR-051-programmatic-gate-integrity.md  --type adr --slug adr-051-programmatic-gate-integrity
cleo docs add T<owner> .cleo/adrs/ADR-051-worktree-extension.md           --type adr --slug adr-051-worktree-extension
cleo docs add T<owner> .cleo/adrs/ADR-052-caamp-keeps-commander.md        --type adr --slug adr-052-caamp-keeps-commander
cleo docs add T<owner> .cleo/adrs/ADR-052-sdk-consolidation.md            --type adr --slug adr-052-sdk-consolidation
cleo docs add T<owner> .cleo/adrs/ADR-053-playbook-runtime.md             --type adr --slug adr-053-playbook-runtime
cleo docs add T<owner> .cleo/adrs/ADR-053-project-agnostic-release-pipeline.md --type adr --slug adr-053-project-agnostic-release-pipeline
cleo docs add T<owner> .cleo/adrs/ADR-054-manifest-unification.md         --type adr --slug adr-054-manifest-unification
cleo docs add T<owner> .cleo/adrs/ADR-054-migration-system-hybrid-path-a-plus.md --type adr --slug adr-054-migration-system-hybrid-path-a-plus
cleo docs add T<owner> .cleo/adrs/ADR-068-canonical-agent-system.md       --type adr --slug adr-068-canonical-agent-system
cleo docs add T<owner> .cleo/adrs/ADR-068-cleo-database-charter.md        --type adr --slug adr-068-cleo-database-charter
cleo docs add T<owner> docs/adr/ADR-068-per-worktree-handoff.md           --type adr --slug adr-068-per-worktree-handoff
cleo docs add T<owner> .cleo/adrs/ADR-070-three-tier-orchestration.md     --type adr --slug adr-070-three-tier-orchestration
cleo docs add T<owner> .cleo/adrs/ADR-070-verifier-backed-ac-auditor-loop.md --type adr --slug adr-070-verifier-backed-ac-auditor-loop
cleo docs add T<owner> .cleo/adrs/ADR-072-unified-llm-provider-architecture.md --type adr --slug adr-072-unified-llm-provider-architecture
cleo docs add T<owner> docs/adr/ADR-072-nexus-db-split.md                 --type adr --slug adr-072-nexus-db-split
cleo docs add T<owner> .cleo/adrs/ADR-079-docs-sdk-boundary-contract.md   --type adr --slug adr-079-docs-sdk-boundary-contract
cleo docs add T<owner> docs/adr/ADR-086-nested-nexus-disposition.md       --type adr --slug adr-086-nested-nexus-disposition
cleo docs add T<owner> docs/adr/ADR-088-pm-core-v2-workgraph-relations-completion-criteria.md --type adr --slug adr-088-pm-core-v2-workgraph-relations-completion-criteria
cleo docs add T<owner> docs/adr/ADR-088-release-pipeline-coherence.md     --type adr --slug adr-088-release-pipeline-coherence
```
*(078-docs-provenance + 086-cli-output-contract-e9 + boundary-registry already in SSoT — NOT re-added.)*

**Phase 2 — Assign display aliases** to the loser-of-collision slugs from the next-free pool (one alias-set op per slug; mechanism = the slug-aware numbering allocator). 13 slugs need a fresh alias (the 13 "→next-free" rows). Owner-confirm the pool ordering first (OQ-1/2/3).

**Phase 3 — Dedup the duplicate SSoT row** (`adr-boundary-registry`, 2 rows same sha 0866e1c7, owners T10176/T10223): drop ONE attachment row (keep the canonical owner), content blob is shared so no data loss.

**Phase 4 — Supersede the stale DB tombstone blob** for the pre-rename r2:
```
# logical supersede: DB blob 81ef246e (slug adr-079-r2-satisfies-binding, status Proposed)
#   → canonical adr-081-satisfies-binding (sha 44c9f737, already SSoT)
cleo docs ... supersede adr-079-r2-satisfies-binding -> adr-081-satisfies-binding   # exact verb TBD by impl
```

**Phase 5 — DELETE the two disk forwarding stubs** (079-r1/r2) — see DESTRUCTIVE section.

**Phase 6 — Regenerate `docs/adr/` + `.cleo/adrs/` projections from the SSoT** once `cleo docs publish` is idempotent + `cleo check canon publish` gate exists (per reconciliation §5 PHASE 1d/5). This is the only step that rewrites on-disk files, and only DB→disk.

## DESTRUCTIVE STEPS — REQUIRE OWNER GATE

Every operation below mutates authoritative state and must NOT run without explicit owner approval. None executed.

1. **DELETE disk file** `.cleo/adrs/adr-079-r1-ac-stable-ids.md` — sanctioned tombstone; content is a forwarding stub → `adr-080-ac-stable-ids` (which exists in SSoT, sha 65b41618). Git-tracked: removal is a tracked-file delete.
2. **DELETE disk file** `.cleo/adrs/adr-079-r2-satisfies-binding.md` — sanctioned tombstone; forwarding stub → `adr-081-satisfies-binding` (SSoT sha 44c9f737). Git-tracked.
3. **DROP one duplicate SSoT attachment row** of `adr-boundary-registry` (sha 0866e1c7 appears twice, owners T10176 & T10223). Shared blob → no content loss; verify which owner row is canonical before dropping.
4. **SUPERSEDE/retire the stale DB blob** `81ef246e` (slug `adr-079-r2-satisfies-binding`, the pre-rename FULL Proposed body) in favor of `adr-081-satisfies-binding`. This changes SSoT provenance edges.
5. **(Phase 6) OVERWRITE on-disk projections** `.cleo/adrs/*.md` + `docs/adr/*.md` when regenerating from the SSoT. DB→disk only; gated on idempotent publish.

**No `git commit`/`push`, no `cleo exodus migrate`, no DB schema change is implied by this plan.**

## OPEN QUESTIONS FOR OWNER

- **OQ-1 (051 — which keeps display 051):** three distinct decisions share 051. Provisional: `programmatic-gate-integrity` keeps 051 (it is the override/evidence ADR most-cited by CLEO-INJECTION's evidence ritual). Confirm, or pick a different anchor; the other two take 040/060.
- **OQ-2 (alias-pool ordering & 040/060 reuse):** is it acceptable to assign the historical gaps **040** and **060** as fresh display aliases? Policy says "next-free, no reuse" — 040/060 were never assigned, so they are free, but they are low/out-of-sequence visually. Alternative: assign everything sequentially from **091+** and leave 040/060 documented as permanent historical gaps (T11192). Owner to choose.
- **OQ-3 (088/087 mislabel):** `ADR-088-release-pipeline-coherence.md` content titles itself **"ADR-087"**, but **087 is already taken** by `ADR-087-worktree-ffi-topology`. It cannot reclaim 087. Confirm it should take a fresh next-free alias and its body's "ADR-087" header be corrected to its new alias on next regeneration (Phase 6).
- **OQ-4 (ADR-090 reservation):** the reconciliation doc reserves **ADR-090** for the slug-primary policy ADR (T11193). Should the alias pool SKIP 090 (use 091+), or is 090 already consumed by T11193? Affects every "→next-free" assignment.
- **OQ-5 (canonical owner of duplicate boundary-registry row):** two SSoT rows for `adr-boundary-registry` exist under owners T10176 and T10223 — which owner is canonical to keep when dropping the duplicate?
- **OQ-6 (ingest owner / authorship):** `cleo docs add` requires an owner task id. Should all 20 re-ingested ADRs be owned by T11676 (this reconciliation), or should each retain its original authoring task (recoverable from git history)? Original-author preserves provenance but is more work.
- **OQ-7 (disk projection authority during transition):** until Phase 6 idempotent publish lands, `.cleo/adrs/` remains the de-facto authoritative copy for the 21 not-yet-ingested ADRs. Confirm the SSoT-wins rule is suspended for these until ingest completes, to avoid the DB (which lacks them) "winning" with emptiness.
