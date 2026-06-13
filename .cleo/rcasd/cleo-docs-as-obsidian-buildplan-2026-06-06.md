# Cleo Docs IS Obsidian — build plan (research synthesis 2026-06-06)

Source: research workflow `cleo-docs-as-obsidian-research` (5 agents). Full findings:
`~/.temp/claude-1000/-mnt-projects-cleocode/cfafb395-*/tasks/w3b1zy55o.output`.
Complements the ratified `.cleo/rcasd/obsidian-view-design-2026-06-05.md`.

## Verdict
~70–75% to BIDIRECTIONAL Obsidian integration; ~30–40% to STANDALONE ("don't NEED Obsidian").
Dominant gap is NOT transport (gateway HTTP+SSE primitives exist) — it's that the **docs SSoT's own read/write core is unreliable**, and the **docs domain is another half-migrated exodus domain** (same class as the provenance cutover): `display_alias` is split-brain (on live 43-row `attachments`, absent on the 2765-row `docs_attachments`), `docs_wikilinks` has 0 rows, slug-fetch is broken.

## The reframe vs the ratified plan
- Ratified plan = a thin EXTERNAL Obsidian plugin as a live **read-only derived view** of cleo.db.
- User reframe ("Cleo Docs IS Obsidian, don't NEED Obsidian") = CLEO must host its OWN editor + backlinks + graph (Studio) AND accept writes back. That's 2–3 phases beyond the ratified view (net-new Studio editor app + vault→cleo.db inbound sync). Re-scope accordingly — "thin plugin" ≠ "standalone Obsidian".

## Smallest shippable proof (CORE-first, no UI/daemon)
1. Run `rebuildDocsWikilinks()` once against the 2765-row corpus → `docs_wikilinks` 0 → real edge graph (idempotent). **Cheapest high-leverage unblock.**
2. Fix `docs.fetch` to accept a **slug** (wire to already-shipped `readDoc(slug)`; today it only takes attachmentRef/SHA — T11877/DHQ-054).
→ `cleo docs view <slug>` (already shipped) becomes a faithful, slug-addressable, backlink-aware Obsidian reader from ONE store. Proves the reframe at the data layer before any gateway/Studio/plugin.
⚠️ Footgun: confirm WHICH physical table the runtime reads before any one-shot derivation/backfill (the docs_ split-brain).

## Build sequence
- **E0 CORE-first (BLOCKING):** T11877 fetch-by-slug · T11876 slug-uniqueness/dedup on add · T11878 reliable remove/dedup · T11879 supersede writes the wikilink edge. (Fix the SSoT before any view.)
- **E0b display-alias (T11875):** add `display_alias` to the consolidated `docs_attachments` shape, backfill 2765 rows, stop deriving numbering from slug, then commit T11676 ADR reconciliation (resolve 3×ADR-051 / 3×ADR-068 collisions).
- **E1 derive graph:** run `rebuildDocsWikilinks()` (idempotent); verify non-zero edges.
- **E2 register gateway ops:** add `docs.read`/`docs.graph`/`docs.list` to the OperationName union + registry (wrap existing SDK fns; no new logic).
- **E3 wire gateway daemon:** register `defineGatewaySubsystem` in daemon boot (currently never imported) + bind `startHttpServer` on loopback **with origin+bearer-token guard from day one**. Deliverable: `curl POST 127.0.0.1:PORT/query/docs/read {slug}`. (Also the T11769 prerequisite.)
- **E4 docs-changed SSE:** `GET /query/docs/events`, start with a 2s poll of `docs_attachments`/`docs_wikilinks` version/sha256 (mirror Studio tasks/events).
- **E5 Studio /docs (proof-of-life, read-only):** consume docs.read+graph+SSE; reuse BrainGraph/Cosmograph renderers.
- **E6 thin Obsidian plugin (~200–300 LOC, ratified Phase 3):** fetch docs.read, render markdown+base64 blobs, EventSource on docs/events, backlinks pane from docs.graph. Bridge, not logic. Build artifact, not a workspace package.
- **E7 TRUE bidirectional edit:** vault→cleo.db inbound sync (file-change observer → docs.update); gate behind E0 write-reliability. Needs a conflict/merge design (none exists — naive LWW risks SSoT loss).
- **E8 STANDALONE "IS Obsidian":** net-new Studio markdown editor (codemirror/milkdown) + `[[wikilink]]` autocomplete against docs.list + live preview + backlinks pane + full CRUD via gateway. Obsidian becomes optional.
- **E9 standardization swap (post-T11769):** repoint plugin+Studio at the generated `/v1` OpenAPI client. Pure transport swap.

## Hard dependencies / risks
- **Blocked on the reconciler heal:** every step needs a working cleo + the live DB. Cannot run/validate `rebuildDocsWikilinks`, backfill, or any docs op until v2026.6.10 heals the DB + the fixed binary is installed.
- Markdown body `[[wikilink]]` parsing is OUT of scope today (edges are structured-only) — a user editing in Obsidian/Studio writes body `[[links]]` the graph ignores → silent divergence unless body-link parsing is added.
- Daemon HTTP listener widens attack surface — origin+token guard MANDATORY before E6.
- docs versions/audit/search (T11880) unimplemented — early deliverables are read+link+graph only; manage expectations.
