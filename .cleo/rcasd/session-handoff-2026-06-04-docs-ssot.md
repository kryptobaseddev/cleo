# Session Handoff — 2026-06-04 (docs-SSoT/vault reconciliation + repo-docs cleanup)

**Saga:** T11778 SG-DOCS-VAULT-SSOT · **Branch:** chore/T11778-repo-docs-cleanup (commit e88aaa46d) · **Decision SSoT:** `cleo docs fetch docs-ssot-vault-reconciliation`

## Ratified (council + owner Ask, all in SSoT)
1. **cleo.db `docs_*` = SOLE doc authority.** docs/adr, docs/generated, Obsidian vault = derived non-authoritative projections.
2. **AUTH-DIR:** Obsidian = LIVE PLUGIN VIEW reading cleo docs (base64 blobs) via a new `docs.read` core-SDK API; vault canon ingested DB-first.
3. **ADR-076 → AMEND (AMD-002).** 4. **ADRs SLUG-PRIMARY** (numbers = display aliases, no v#/-rN). 5. **OBS-GRADE:** minimal `docs_wikilinks`. 6. **SCOPE:** PROJECT now, GLOBAL post-exodus.

## Done this session
- **Cleanup committed (e88aaa46d, branch — NOT pushed):** 29 deleted (16 junk + 6 vision/design + 7 distilled) · 9 bannered · 7 distilled→`cleo docs fetch distilled-retired-docs-signal` (brain-viz 14 decisions, Circle-of-Eleven lore, autonomy primitives — verified intact) · 113 keep-repo · 3 owner-judgment left. Repo docs 176→147.
- **ADR cross-store identity map** → `cleo docs fetch adr-cross-store-identity-map` (T11191): 11 divergent numbers (051×3, 068×3…), gaps 40/60, 079-r1/r2 tombstones.
- **Task graph:** saga **T11778** + epics T11779/80/81 + 8 tasks (T11820-27) + regression **T11828** (DHQ-059) + re-scoped T11067/T11191/T11192/T11193 slug-primary.
- **DHQ:** filed **DHQ-059** (T11828, silent write-rollback) + **DHQ-060** (T11829, store-corruption resilience); 2 facets + 5 confirmations appended to docs/plan/dogfood-harness-question-ledger.md.

## Incidents (resolved, but follow-ups open)
- WAL corruption (owner restored from 09:57 VACUUM backup, no loss). exodus-on-open instability (owner stabilized; writes 2s now). **BUT T11662 is DONE yet RECURRED** → T11828 (DHQ-059) P1. Legacy DBs (brain.db 1.7GB, nexus/signaldock/skills) still on disk — reap via exodus utility (T11824).

## NEXT SESSION (priority order)
1. **T11828 / DHQ-059** (P1) — fix exodus-on-open silent write-rollback (CORE store; blocks reliable task writes).
2. **T11829 / DHQ-060** (P1) — CORE store corruption resilience (self-heal, no external sqlite3).
3. **T11820 + T11676** — AMD-002 + ADR cross-store reconcile (use the identity map; slug-primary; do NOT republish before reconcile or it clobbers divergent ADRs).
4. **T11823** — DB-first ingest of vault canon (north-star/tools/skills) → DB authoritative.
5. **T11825-27** — docs.read SDK API → Obsidian plugin → docs_wikilinks (the Obsidian integration build).
6. **T11824** — verify exodus reaps legacy DBs.
7. CORE-ergonomics (owner: CORE/TOOLS first, not CLI): DHQ-057/T11692 (per-op output schema), DHQ-017/T10970 (docs fetch decoded-text), DHQ-056-facet/T10965 (docs add --content inline).
8. Push branch + open PR for the cleanup commit (owner to decide).
