---
id: t13359-decision-adr-links
tasks: [T13359]
kind: feat
summary: Decisions-vs-ADRs methodology — decision_adr_links syncing link table with natural (decision_id, adr_slug) identity, one-way revoke tombstones, and two-way surfacing (docs fetch shows linked D#### decisions; decision.find shows linked ADR slugs).
---

Implements spec `cleodocs-rearch-design` §4/§10 (D11165): the ledger stays the operational authority and ADR docs stay curated records authored at graduation — never generated from the ledger. The new `decision_adr_links` table (SYNCING, append-only, portable-project) links both tiers with a natural composite key so concurrent identical links coalesce on apply; unlink is a one-way monotonic tombstone latch (`status` → 'revoked'), never DELETE or re-link. `cleo docs fetch <adr-slug>` surfaces the linked `D####` decisions on the envelope (`linkedDecisions`), and `cleo memory decision.find` attaches each decision's linked ADR slugs (`linkedAdrs`) — one link row, both directions. Canonical accessors live in `store/decision-adr-links.ts` (gate-28 clean, `@sync-invariant` tagged); the table is declared in ROW_IDENTITY (gate 37), classified (gate A), carries a deterministic forward-only migration with no DML (gate 36, AC4: the ~360 existing decisions are untouched), and the gate-38 registry gains `docs.decision-adr-links.revoke-monotonic`. The docs taxonomy/canon routing is unchanged — the ADR lifecycle itself does not change (AC3).
