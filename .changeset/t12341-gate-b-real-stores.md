---
id: t12341-gate-b-real-stores
tasks: [T12341, T12749, T13219, T13220]
kind: test
summary: real-store Gate B harness for row identity; 4 of 5 stores pass, cleocode fails the from-scratch check, so row uids stay off by default
---

`scripts/row-identity-real-store-gate-b.mjs` runs row-identity Gate B on a backup of one real store,
and never on the live store. In each project, the installed `cleo backup add` makes the backup
through the store's own chokepoint. The harness copies it to `raw.db` and reads only copies. It
opens five independent copies through the runtime path, each in a sandboxed child process with a
timeout:

- one with the fill off;
- two with it on in UTC, and one in America/Los_Angeles;
- one "scratch" copy with every identity value cleared first.

It runs seven checks:

1. replay with `--omit-row-identity` (Gate B, plus Gate C's dangling and invariant counts);
2. determinism: two fills compared with identity hashed;
3. timezone: UTC vs America/Los_Angeles, identity hashed;
4. a negative control that must fail, proving the fingerprint sees the identity columns;
5. from scratch: the scratch copy, with every identity column of every declared table set to NULL
   and the recipe marker removed, filled from nothing, must equal the normal fill. It is skipped,
   with the reason recorded, when the store's identity has already synced;
6. completeness across all declared tables;
7. the fill-off open writes no identity value, checked by per-column value digests.

On 2026-10-05, llmtxt, axiom-app, cleo-nexus and axiom-instrument-studio passed every check.
**cleocode fails check 5.** It keeps pre-release uids on 201 symmetric `related` task relations
and on one acceptance criterion (with its history and evidence-binding `ac_uid`). A device filling
from scratch would derive different values. The results are in spec `t12341-uid-scheme` v13,
§15.0.

The real-store precondition of T12749 is therefore **not** met. `CLEO_ROW_UID_FILL` stays off by
default until T13231 (a full from-scratch refill for unshared stores whose recipe marker is stale)
lands and check 5 passes on cleocode.
