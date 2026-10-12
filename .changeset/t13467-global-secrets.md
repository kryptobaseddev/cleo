---
id: t13467-global-secrets
tasks: [T13467, T12915]
kind: feat
summary: "Global credentials sync with their secrets: sealed in cloud sync, re-encrypted on the receiving device"
---

`accounts`, `service_connections`, `service_configs` and `agent_service_grants`
now carry a row uid, natural on their non-secret identifiers (provider and
label, provider, agent and connection; uid spec D4 amended 2026-10-11). The same
credential held on two devices is one row. A grant references its connection by
uid on the wire and by each device's own local id at rest.

Their secret columns travel sealed on the home stream (journal spec §2.5, §2.7).
The open-time sealer leaves a credential row's ops pending; `cloud sync`, which
holds the master key, decrypts each machine-key credential, seals it under the
secret-values key, and sends it. The receiver opens it and re-encrypts it under
its own machine key before the apply frame, so the row arrives usable and the
secret never appears in plaintext in a segment. A device that is not logged in
holds the ops. Agent API keys never travel. A vault restore no longer matches
rows by a row uid that may still be unfilled.
