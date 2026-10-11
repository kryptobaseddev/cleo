---
id: t12915-agent-registry-identity
tasks: [T12915]
kind: feat
summary: "Global agent registry gets row identity: agents natural on their slug, local id never travels"
---

`agent_registry_agents` now carries a row uid, natural on its slug (`agent_id`),
so every device derives the same uid for the same agent. Its random text `id`
is a local key declared with the new `localKey` row-identity field: it never
travels, references to the table resolve through it to the row's uid, and a
received agent takes its uid as its local id. `owner_id` and `organization_id`
point into the local-only better-auth mirror and stay local.

Per the owner decision (`cleo docs fetch t13467-global-secrets-sync-design`):
the agent capability and skill junctions are derived (rebuilt from the agent's
own columns), the legacy capability and skill catalogs and
`agent_registry_accounts` / `agent_registry_org_agent_keys` are local-only. The
four whole-table secret tables (`accounts`, `service_connections`,
`service_configs`, `agent_service_grants`) stay exempt and uncaptured until
T13467 declares them together with secret sealing. Gate 37: global exemptions
25 → 18.
