---
id: spawn-store-refusal-envelope
tasks: [T14490]
kind: fix
summary: "a spawn refused by a store refusal keeps that refusal's code, exit code and fix instead of E_SPAWN_FAILED or a bare numeric code"
---

Both spawn entry points now map a thrown `CleoError` through the shared
`cleoErrorToEngineResult` helper before their catch-all fallbacks. The custody
read opens the project store before adapter preflight, so `E_STORE_RESTORING`
(another process is replacing the store) and `E_WORKTREE_BUILD_SCHEMA` (a
worktree build would migrate a foreign store) reached the spawn catches and
surfaced as `E_SPAWN_FAILED` — or as a raw numeric `error.code` — with their
repair text dropped. `orchestrateSpawn` and `orchestrateSpawnExecute` now
return the refusal's own code name, message, exit code and `fix`.
