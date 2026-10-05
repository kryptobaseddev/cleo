---
id: t13126-mutation-weight
tasks: [T13126]
kind: fix
summary: cleo add, update and other mutations no longer fetch models.dev on every call; cleo config get ~120 MB instead of ~250 MB
---

- **No network round trip per mutation.** Every CLI mutation records its token usage, and the
  provider lookup fetched `https://models.dev/api.json` (about 10 MB of JSON, with a 1.5 s
  timeout) even though the CLI records no model, so the answer was always "none". A lookup with
  no model now returns at once. `cleo update` drops from ~212 to ~178 MB, and no command makes that
  request any more.
- **One schema, not forty.** The audit middleware validated each audit row with
  `AuditLogInsertSchema` from `store/validation-schemas`, which builds the drizzle-zod schemas of
  every table at load. The schema now lives in its own module (`store/audit-log-schema`), and
  `validation-schemas` re-exports it.
- **`cleo config get|set|list|drift-check`** import their CORE helpers from the modules that
  define them: ~2,750 → ~420 modules, ~250 → ~120 MB.
- **The rest of the admin domain:** `context pull`, `detect`, `install global`, the db and brain
  probes no longer import the CORE barrel.

53 commands produce identical output and a hook-firing sequence leaves identical row counts.
Gate 39 adds a `config get` probe; gate 19's baseline drops from 99 to 95.
