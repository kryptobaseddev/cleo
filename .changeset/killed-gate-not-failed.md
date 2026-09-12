---
id: killed-gate-not-failed
tasks: [T12137]
kind: fix
summary: a gate killed by its own timeout is recorded as `error`, not `fail` — a false red is as costly as a false green (gh#1270)
---

A gate killed by its timeout was recorded as `fail`. An agent then reports a red
that never happened, and redoes or abandons work that actually succeeded.
Reported twice from the field: *"Agents twice reported a gate as FAILED when it
had only been killed."*

A false green ships unverified work — bad, and widely understood. A **false red**
destroys completed work and writes an assertion into the evidence record that a
check found a problem when no check ever finished. Nothing downstream can tell
that record from a real failure, and in a multi-agent run a peer reading the
gate state inherits the wrong conclusion.

The distinction already existed. `AcceptanceGateResult['result']` has carried
`'error'` alongside `'fail'` all along; the timeout path simply did not use it,
and the contract did not say what the difference meant. Both are fixed: three
timeout returns now produce `'error'`, and the union is documented — `fail` is a
verdict, `error` is the absence of one, and consumers must treat `error` as
"unknown, re-run" (which `lifecycle/index.ts` already does, resolving it to
`pending`).

The advisory override stays keyed on `'fail'` alone, deliberately. `advisory`
softens a verdict; a killed gate has no verdict to soften, and `warn` reads as
"we looked and it was nearly fine" — the opposite of "we never finished
looking".

Tuning the timeout could not have fixed this: the same report measured a 180x
filesystem difference (11,555 `.ts` files — 113,748 ms on fuse vs 632 ms on
btrfs), so any fixed deadline is wrong somewhere by two orders of magnitude.
