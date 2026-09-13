---
id: legacy-reaper-detection
tasks: [T12131]
kind: fix
summary: cleo doctor legacy-reaper detects the hand-applied MCP reaper that terminates live Codex CLI sessions (gh#1187)
---

A helper script and systemd user timer applied by hand during a 2026-07-01 OOM
investigation select victims by `/proc/PID/comm === 'MainThread'` — a generic
Node launcher comm, not an MCP signature. The npm-distributed Codex CLI has
exactly that comm and deliberately forwards SIGTERM to its native child, so the
reaper ends a live Codex session cleanly, with no crash and no coredump. It was
first misdiagnosed as a Codex bug; journal correlation later paired eight Codex
exits with reaper kills to the second.

The artifacts were never package-owned and appear nowhere in CLEO's git history,
so no upgrade has ever removed them — they keep running on every host that got
them. No upstream process-title hardening can make `pgrep -x MainThread` safe:
comm identifies a runtime, not an owner.

`cleo doctor legacy-reaper` detects the script and units and classifies them.
Only an ARMED timer fails; present-but-masked leftovers are reported without
failing, because a check that cries wolf is one operators learn to skip. `--fix`
disables and masks the units and deliberately leaves the helper script in place
— it and its journal are evidence of a real incident.

CLEO's own janitor already discriminates correctly (scope/pgid primary,
signature plus age only for unregistered processes whose stdio peers are dead,
scope reaping restricted to `cleo-*` units inside `cleo.slice`, never touching
`run-*.scope`), so the canonical replacement already existed — the gap was
purely that the unsafe predecessor stayed installed and undetected.
