---
id: t13126-registrations-entry
tasks: [T13126]
kind: fix
summary: cleo add, update, start, complete, next and focus no longer load all of CORE; ~150-240 MB instead of ~260-295 MB
---

Every CLI operation outside the barrel-free reads loaded the whole `@cleocode/core/internal`
barrel (~3,000 modules, the OpenAI and Anthropic SDKs included) before dispatching, only to get
the registrations a few CORE modules perform while they load: the lifecycle hook handlers, the
LLM credential seeders, the release invariants.

- The CLI now loads `@cleocode/core/registrations` instead: exactly the modules whose loading
  registers something. A new test scans the barrel's module graph for top-level side effects and
  fails when one is not reachable from `registrations`, so a future registration cannot go
  missing.
- `cleo add` and `cleo update` import their CORE helpers from the modules that define them, and
  the focus domain no longer imports the barrel.

Measured on the built CLI: `next` 2,998 → 972 modules (263 → 153 MB), `add` 3,011 → 1,306
(262 → 183 MB), `focus` 2,991 → 1,165 (268 → 186 MB), `start` 1,009 modules / 152 MB,
`complete` 1,078 / 175 MB. 47 commands produce identical output (start, complete, session end and
dash included), and a hook-firing sequence leaves identical row counts in every table. Gate 39
adds `next` and a session-bound `add` probe.
