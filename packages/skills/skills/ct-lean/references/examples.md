# ct-lean worked examples

Each example names the request, the over-built answer agents tend to write, and the lean
answer. The lean answer is complete: it touches every place the change must reach.

## 1. "Add a `--json` flag to a CLI command"

- **Over-built:** a new formatter module, an `OutputMode` enum, a config key for the default.
- **Lean:** none of it. Every `cleo` command already emits one LAFS envelope and supports
  `--output`/`--field` (ADR-086). Answer with the existing flag. If one is truly missing, wire
  the command through `defineCommand` so it inherits the flag; never hand-roll JSON.

## 2. "The import fails when the file has a BOM"

- **Over-built:** a try/catch at the one failing call site that strips `﻿`.
- **Lean:** grep every caller of the shared reader, then strip the BOM once inside it. Add one
  test with a BOM fixture. The call-site patch is a workaround that the next caller repeats.

## 3. "Cache the provider lookup, it is slow"

- **Over-built:** an LRU class with TTL, size options and invalidation hooks.
- **Lean:** measure first. If the lookup is a pure function of static data, a module-level
  `Map` (or computing the table once) is enough. Add the TTL only when a test shows stale
  data. Leave `shortcut: no invalidation, data is static per process; add TTL if it becomes
  config-driven`.

## 4. "Write rows to a new table"

- **Over-built:** a raw `new DatabaseSync(...)` with hand-written `INSERT OR REPLACE`.
- **Lean, and the only correct option:** go through `openDualScopeDb` and the canonical
  accessor, and use `INSERT … ON CONFLICT … DO UPDATE`. Gates 3 and 28 reject the short
  version. A smaller diff that breaks a gate is not smaller.

## 5. "Fix the flaky test"

- **Over-built:** a retry wrapper, or a larger timeout.
- **Lean:** find the race (shared temp dir, unawaited promise, real clock) and fix it at the
  source. Never edit the expectation to match broken behaviour.

## 6. Reply shape

```
Fixed: the BOM is stripped once in readJsonFile (packages/core/src/store/json.ts).
- 1 new test (json.test.ts > strips a UTF-8 BOM); 14/14 pass
- tsc -b and biome clean
Skipped: did not audit the two callers in studio (they read via the same function).
```
