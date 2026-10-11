---
id: t13354-conduit-history-rekey
tasks: [T13354]
kind: feat
summary: CleoDocs schema re-key — conduit history tables FK the immutable doc uid (no cascade delete), version DAG identity, per-version per-section approvals, derived contributors, slug aliases, max-HLC head projection, local-only section CRDT states.
---

The conduit_attachment_versions/approvals/contributors tables are rebuilt from the slug FK (cascade delete) to the Stage C row uid per spec cleodocs-rearch-design §3/§10 (team-sync verdict, D11165): version identity is row uid + parent_version_uid with version_number demoted to a display ordinal; approvals key on version uid (+ section id) with tombstone revokes; contributors becomes a derived rollup rebuilt from versions after apply and is not synced. New tables: conduit_doc_slug_aliases (old-slug lookup, natural identity), conduit_doc_heads (current-version projection with conflict recording on losing concurrent heads, typed rule docs.head.max-hlc), and section_crdt_states (local-only Loro state). store/conduit-doc-history.ts is the canonical accessor set; classification flips from needs-owner-call to decided, row identity is declared (CONDUIT exemption pin 76 → 72), and gates 28/36/37/38 carry the change.
