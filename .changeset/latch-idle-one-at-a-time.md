---
id: latch-idle-one-at-a-time
tasks: [T14088]
kind: fix
summary: "while the memory latch waits below its refuse line and CLEO holds nothing, admission starts one run at a time in queue order instead of refusing every project"
---

After pressure crossed the refuse line (25), the memory gate latched and
stayed shut at 22–24 until pressure fell to the resume line (15). That took
well over an hour, and every project's `cleo run` timed out
`E_RESOURCE_DEFERRED` after 1800 s, while CLEO itself held nothing. The
pressure came from other processes (codex sessions, OrbStack, opencode), so
refusing every run relieved nothing.

- While the gate is latched at or below its refuse line and no CLEO run is
  admitted, each scheduling pass admits one run: the first the queue would
  start under a one-at-a-time share, tiny reserve included. Nothing starts
  beside it until it releases, so load does not stack.
- Above the refuse line nothing is admitted, as before. With a CLEO run
  admitted, the latch behaves as before.
- The wait report, the refusal reason and `cleo doctor tool-locks` say that CLEO
  holds nothing and that the latch is held by memory outside CLEO. The host's
  largest memory users are listed next to it.
