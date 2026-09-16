---
id: t12221-no-double-wrap-and-named-scope
tasks: [T12221]
kind: fix
summary: Do not wrap a command that is already systemd-run; name the scope we do create; a harness that never started no longer reports as a red suite (gh#1396, gh#1397)
---

CLEO wrapped `test` and `build` in a `systemd-run` scope (T12116) without
checking whether the command it was handed already had one. `axiom-analytics`
pins a `testing.command` that IS a systemd-run invocation, and
`parseCommandString` splits on whitespace, so `command.cmd === 'systemd-run'`
and CLEO prepended a second. `systemd-run --scope` execs its payload rather
than forking, so the inner client regenerates a unit name the outer has
already registered.

Measured on systemd 259, this host: nested `systemd-run … -- systemd-run … --
/bin/true` fails 5/5 with `Unit run-p<pid>-i<id>.scope was already loaded or
has a fragment file`; a single invocation fails 0/6. That is the deterministic
4-of-4 the reporter saw, why an idle box reproduces it, and why cleocode's own
repo never could — its test command is `pnpm run test`, so nothing double-wraps.

The collision is the symptom; the double wrap is the defect. Declining it is
the rule this codebase already applies twice: `heapCapApplied()` does not
re-exec over an operator's own `NODE_OPTIONS` heap cap, and `mergeNodeOptions()`
lets an existing explicit value outrank our default. A project pinning
`-p MemoryMax=8G` has made that same explicit choice, and a second ceiling it
did not ask for is the thing to avoid.

Detection is systemd-run-specific. `env`, `nice`, `taskset` and `timeout` are
plausible leading tokens too, but none imposes the cgroup memory bound this
function exists to apply, so treating them as already-confined would silently
drop the ceiling.

The scope CLEO does create is now named `cleo-tool-<canonical>-<rootHash8>-<rand8>.scope`.
`--scope` selects the unit TYPE and `--unit=` supplies its NAME; they are
independent and compose. The TSDoc asserted they were alternatives for the whole
life of this defect, and that one sentence is the bug. `rootHash8` comes off the
same execution root the cache key uses (T12112 / gh#1220), so the scope and the
cache agree on what "the tree under test" means. The PID is deliberately absent:
it is the component that makes systemd's auto-generated name collide, and it
defends nothing randomness does not.

A second defect closes with it. `suite-reaper.ts` reaps via
`systemctl --user stop <unitName>` and could never target a heavy-tool scope
while the name was systemd's auto-generated one. Naming makes those scopes
enumerable (`list-units 'cleo-tool-*'`) and individually stoppable by the
reaper that already exists.

## gh#1397 — the silencer, and why it is fixed first

`systemd-run --scope` is transparent on success: it exits with the wrapped
command's status (a scope running `sh -c 'exit 7'` makes systemd-run exit 7).
When it cannot create the unit it exits 1 and the payload never runs. `1` is
also what a suite with a failing test exits with, so "the harness never started"
and "the suite ran and was red" were identical in everything `validateTool`
examined, and every harness failure was reported as `E_EVIDENCE_TOOL_FAILED`:
a suite that failed in about two seconds. Five occurrences of gh#1396 produced
no diagnosis for that reason.

`E_EVIDENCE_TOOL_UNAVAILABLE` was always the right code. What was missing was a
route into it: the existing guard keys on `exitCode === null`, and systemd-run
itself starts perfectly well before failing. A harness failure is now routed
there, quotes systemd's own diagnostic, and is NOT cached — the cache key cannot
rotate on an unchanged tree, so a persisted harness failure would serve a
fabricated "your tests failed" forever without spawning again.

`spawnCmd` also stopped discarding Node's spawn-error object, which is the same
defect gh#1381 fixed one event-handler over for `signal`.

## The near-regression, stated because the narrower gate is the obvious one

The harness-failure classifier was first gated on `limited.confined` — "did CLEO
wrap this". Detection makes `confined` false for exactly the axiom-analytics
shape, so that gate would have silently reintroduced gh#1397 for the one project
that reported it: a fix composing with an adjacent fix to restore the original
symptom in a narrower, harder-to-find form. The gate now asks whether the
spawned command was a systemd-run invocation AT ALL, whoever added it. Anyone
proposing the narrower condition again should read that TSDoc first.

## Scope of the claim

The `--unit=` change is a necessary condition proven, not a sufficiency proven.
The nesting mechanism is reproduced here 5/5 and the reporter's config is
confirmed on disk, but the original 4-of-4 occurrences were observed on another
host and are not re-run here.
