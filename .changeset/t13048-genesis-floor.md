---
id: t13048-genesis-floor
tasks: [T13048]
kind: fix
summary: A v3 genesis checkpoint that covers segments must sit at or above their highest schema rise
---

The cloud manifest check floored a v3 checkpoint's `schemaVersion` only when it had a parent. A genesis
checkpoint covering segments (the vault's first push when segments precede it) could claim a lower
version, and its child would then have to re-declare a rise the replay had already made. The genesis
branch now floors at the window's highest rise (`schemaRises`, never a spread: a genesis window is
unbounded) and refuses a lower value with `schema-version-below-floor`, matching the Cleo Nexus server
(T090, cleo-nexus #31).
