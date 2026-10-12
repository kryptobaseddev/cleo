---
id: t13598-docs-link-decision
tasks: [T13598]
kind: feat
summary: "cleo docs link-decision / unlink-decision trace an ADR to its D#### decisions"
---

`decision_adr_links` gains its writer verbs. `cleo docs link-decision
<adr-slug> D####` links a ledger decision to the ADR doc that ratifies it
(repeating is a no-op), and `cleo docs fetch` lists the linked decisions.
`cleo docs unlink-decision <adr-slug> D####` revokes the link as a permanent
tombstone: a revoked pair is refused if linked again.
