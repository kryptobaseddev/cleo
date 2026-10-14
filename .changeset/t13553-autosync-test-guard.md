---
id: t13553-autosync-test-guard
tasks: [T13553]
kind: fix
summary: "The piggyback auto-sync never spawns under a test runner or CI"
---

A normal command in a linked project starts a background sync once sync ships
(T13553). Under `VITEST`, `NODE_ENV=test` or `CI` it now never spawns, so a
linked test fixture cannot start detached syncs that load the machine.
`CLEO_DISABLE_AUTO_SYNC=1` still turns it off everywhere.
