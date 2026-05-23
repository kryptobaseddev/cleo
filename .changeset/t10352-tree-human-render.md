---
id: t10352-tree-human-render
tasks: [T10352]
kind: fix
summary: "cleo tree --human emits canonical box-drawn tree in non-TTY (was empty)"
---

`cleo tree <id> --human` rendered to empty string when stdout was a pipe,
redirect, or CI log because the renderer gated through `AnimateContext`,
which silences when `isTTY === false`. That gate is correct for animation
primitives (spinners must not flicker in pipes) but wrong for static tree
rendering — the user explicitly asked for `--human` output.

`resolveAnimateContext()` now force-sets `isTTY: true` and `noColor: false`
when format is human so the static render path always emits. The ASCII
box-drawing fallback is preserved by reading `process.env.NO_COLOR`
directly inside `renderGenericTree`, and only for the resolved (non-explicit)
context path — explicit `ctx` callers (tests, programmatic usage) honour
`ctx.inputs.noColor` exclusively. Closes the Epic T10114 dogfood gap.
