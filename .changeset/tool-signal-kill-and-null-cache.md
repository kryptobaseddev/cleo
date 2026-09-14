---
id: tool-signal-kill-and-null-cache
tasks: [T12182]
kind: fix
summary: A signal-killed tool no longer reports as a missing binary, and its non-result is never cached
---

`spawnCmd` bound only `code` from Node's `close` event. `close` fires with
`(code, signal)` and exactly one is non-null, so a process killed by a signal
reached the caller as `exitCode: null` — the same value a spawn that never
started produces — one line after the two were distinguishable. `validateTool`
then reported it as `E_EVIDENCE_TOOL_UNAVAILABLE`, whose message is
"binary missing or spawn error".

Measured in the field on 2026-09-14: a 41-minute monorepo test suite, traced
live in `/proc` with seven vitest workers executing, reported as a missing
binary. Three operators independently verified that `npm` and `pnpm` resolved
under `env -i` before anyone questioned the message, and one shipped a fix
against `.cleo/project-context.json` and told three lanes the tool was fixed —
because `E_EVIDENCE_TOOL_UNAVAILABLE` reads as "CLEO is misconfigured". The
error did not merely fail; it named a cause and people acted on it.

The real cause is `withMemoryLimit` (T12116) running `test` and `build` inside
a systemd scope with `MemorySwapMax=0`, so the kernel kills the whole cgroup
when the suite exceeds the ceiling. **The ceiling is not the bug** — without
it the failure is a throttle-and-thrash host freeze that logs nothing at all,
which is strictly worse to diagnose than a clean kill. The discarded `signal`
was the bug.

That `exitCode: null` was also written to the evidence cache. The `timedOut`
branch already declined to persist a non-result; a signal kill that is not a
CLEO timeout had no equivalent guard. Where the tool runs off a non-git root,
`head` and `dirtyFingerprint` are null too — and both are components of the
cache key, so the key cannot change, and a key that cannot change can never be
invalidated by a commit or an edit. One killed run then served a cached
"binary missing" forever without ever spawning again. A single false pass is
one wrong answer; a permanent false failure blocks every gate on that tool and
no amount of correct work clears it.

Changes:

- `spawnCmd` binds `signal` and carries it through `CommandResult`,
  `ToolCacheEntry` and `ToolRunResult`.
- New `E_EVIDENCE_TOOL_KILLED` for a tool that started and was killed, naming
  the signal, the elapsed time, the execution root, and the output captured
  before the kill. `E_EVIDENCE_TOOL_UNAVAILABLE` now means what its message
  always said — the process never started — and says so explicitly.
- The killed message reports the signal as **measured** and the memory ceiling
  as **configured**, side by side, and does not assert OOM. `SIGKILL` inside a
  bounded scope is consistent with a cgroup kill and is also what an operator's
  own `kill -9` produces; inferring OOM from the signal alone would be the same
  defect this text exists to fix.
- `runToolCached` does not persist an entry when `exitCode` is null.
- `readCacheEntry` refuses a null-exitCode entry, retiring the ones already
  written by <= 2026.9.1, which cannot rotate themselves out.
- `describeMemoryLimit` derives the ceiling by asking `withMemoryLimit` rather
  than re-testing `isHeavyTool` and re-reading the constant, so a fifth heavy
  tool cannot acquire a message that names a bound it does not run under.

Closes gh#1381, gh#1380.
