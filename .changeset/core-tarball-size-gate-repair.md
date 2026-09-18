---
id: core-tarball-size-gate-repair
tasks: [T12253]
kind: fix
summary: The Core Tarball Size Gate reaches its own assertion for the first time in 47 runs
---

The gate has failed on **every run since v2026.6.10 — 47 runs, 47 failures, 0
successes** — always in the build step, so it never once executed the size
assertion it exists for. Nobody knew whether `@cleocode/core` was under its
30 MB budget.

Two causes, and the first hid the second.

**The pnpm filter ellipsis was inverted.** Trailing `pkg...` selects a package
and its DEPENDENCIES; leading `...pkg` selects it and its DEPENDENTS.
T11976/DHQ-079 switched both filters to the leading form and wrote a comment
asserting the opposite meaning — which is why it survived 47 runs: the filter
looks wrong to anyone who reads the prose and right to anyone who trusts it.
Measured, the leading form selects 12 projects and omits `paths`, `contracts`,
`lafs`, `agents`, `git-shim`, `nexus`, `skills`, `utils` — exactly what
`packages/brain` reported as unresolvable.

**Correcting the direction moved the failure rather than fixing it.**
`packages/adapters` then could not resolve `@cleocode/caamp`. The real obstacle
is that **no pnpm filter expression can order this graph**, because it contains
a production cycle — `core -> adapters -> caamp -> core`, which pnpm names in
the log. A topological sort does not exist, so pnpm picks an arbitrary order and
something always builds before its dependency.

That cycle is precisely why this repo has `build.mjs`, a hand-ordered wave build
whose caamp wave carries an explicit comment about breaking it, and why the
release job builds with `pnpm run build`. The gate now performs the **same build
the release performs** — which is also what makes its number meaningful, since a
bespoke build measures a tarball nobody ships.

First green run, and the figure this gate had never printed:

```
@cleocode/core packed: 11.97 MB / budget 30 MB (unpacked 49.21 MB, 5322 files)
```

**No threshold change is needed.** I expected one — the assertion had never
executed and I would not assume green — but there is 18 MB of headroom. The
budget was never in danger; the gate was broken. For four months this repo had a
size gate that could not have caught a regression, and nobody could tell,
because a red tag-triggered workflow that gates nothing looks exactly like a red
tag-triggered workflow that gates nothing.
