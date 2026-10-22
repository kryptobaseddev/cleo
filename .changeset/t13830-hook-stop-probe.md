---
id: t13830-hook-stop-probe
tasks: [T13830]
kind: perf
summary: "Gate 39 pins the Claude Code Stop hook's no-goal path: about 260 modules, no store and no CORE barrel in the hook process"
---

Claude Code runs `cleo hook stop --provider claude-code` on every turn. A new
gate 39 probe, `hook-stop-no-goal`, runs the installed `cleo` binary's hook
fast path with no `.opencode/goals` workspace. It caps the hook process at 290
modules (about 260 measured, 85 MB) and forbids the CORE and contracts barrels,
the store stack and model SDKs.

Session end stays synchronous so it cannot race the next turn. The hook takes
about 1.1 s end to end because of it; the goal-workspace check and ask-enforce
cost about 200-350 ms. Making `cleo session end` cheap is follow-up T13834.
