---
id: t13663-lean-levels
tasks: [T13663]
kind: feat
summary: "ct-lean levels off/lite/full/ultra: `cleo lean level`, the `lean.level` config key and CLEO_LEAN_LEVEL"
---

ct-lean (adapted from Ponytail 5.1.0, MIT) now runs at a level, matching Ponytail's levels:

- `lite` builds what was asked and names the smaller option;
- `full` is the default;
- `ultra` also questions the request first;
- `off` emits nothing.

The level resolves from `CLEO_LEAN_LEVEL`, then a session-scoped level, then
the `lean.level` config key (project over global), then `full`.

`cleo lean level` shows the effective level and its source.
`cleo lean level <l>` sets it in the project config, `--global` in the global
config, and `--session` for the current CLEO session only; the session level
ends with that session. This replaces Ponytail's prompt-parsing mode tracker
with an explicit verb that works on every harness.

Spawn prompts emit the level-specific `## Lean Change` block (none at `off`),
and the ct-lean skill gains a Levels section (1.1.0).
