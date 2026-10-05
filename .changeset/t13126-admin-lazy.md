---
id: t13126-admin-lazy
tasks: [T13126]
kind: fix
summary: cleo dash, stats and the other admin commands load about 640-970 modules and ~150 MB instead of ~3,000 and ~260 MB
---

The admin dispatch domain imported ~50 CORE operations from the `@cleocode/core/internal` barrel
and `@cleocode/runtime/gateway` up front, so `cleo dash`, `cleo stats` and every admin command
loaded all of CORE. Each operation now loads its own module on first call (synchronous helpers
come from their defining modules).

`dash` 2,999 → ~640 modules (277 → ~150 MB), `stats` 2,997 → 941 (257 → 145 MB). 53 commands
produce identical output and a hook-firing sequence leaves identical row counts. Gate 39 adds a
`dash` probe.
