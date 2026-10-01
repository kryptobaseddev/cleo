---
id: t12840-tls-black-hole-timing
tasks: [T12840]
kind: fix
summary: "System One exit tests assert the deadline fired and the process exited, not a tight wall-clock delta that slow CI runners exceed"
---

The tls-black-hole cases in `decide-duplicate-exit.test.ts` and `observation-owner-sites-exit.test.ts` held the spawned process to the decision budget plus 600 ms over an unconfigured baseline. Process startup on a shared runner varies by more than that between spawns (928 ms over a 2255 ms baseline on #1734), so correct runs failed. The wall-clock ceiling is now 3 s, the teardown backstop's grace: a leaked connect-phase handle still lands above it. The stalled-provider cases also assert the audited in-process `latencyMs` sits between the budget and budget + 700 ms with `fallbackReason: 'timeout'`, which proves the deadline ended the wait without process-startup noise.
