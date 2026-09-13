---
id: lockbusy-behavioural-assertion
tasks: [T12172]
kind: test
summary: The lockBusy test asserts that it did not wait out the stale window, instead of a 2-second wall-clock budget
---

**gh#1254.** `"returns lockBusy:true within 4 s when the cache lock is held
externally"` asserted `elapsedMs < 2_000`. That budget measures
module-resolution cost as much as behaviour, so the test's verdict was decided
by how the working tree was provisioned rather than by the code under test.

Measured across four trees with the assertion held constant:

| tree | `node_modules` | result |
|---|---|---|
| `main`, shared checkout | real install | PASS |
| `main`, fresh worktree | **symlinked** | **FAIL (7.8 s)** |
| feature branch, worktree | symlinked | FAIL (5.5–8.9 s) |
| feature branch, worktree | real install | PASS |

Row 2 is the one that matters: **unmodified `main` failed its own test**, purely
because `node_modules` was a symlink to a shared store.

It cost two sessions. The first three data points available all pointed at an
innocent feature branch and a regression was nearly filed against it; only
running `main` under the same provisioning showed the branch was clean. **A test
that can accuse an unrelated diff is worse than no test.**

The property under test is that a held lock makes `runToolCached` **give up**
rather than wait out `lockStaleMs` — not that it completes inside two seconds.
The bound is now `lockStaleMs` itself, which is what the behaviour implies: had
the code waited for the lock to go stale it would have taken at least that long
and then returned a real result rather than `lockBusy: true`.

Both the option and the assertion now read one `LOCK_STALE_MS` constant, so a
bound that silently stopped matching the option it describes cannot make the
test pass for the wrong reason.

**Coverage stated precisely:** every failure recorded in the issue (5.5–8.9 s)
falls below the new 10 s bound, so the fix covers all observed cases. I did
**not** reproduce the symlinked condition myself — the worktree available to me
carries a real `node_modules` — so that claim rests on the issue's measurements
rather than on a fresh run of my own. 36/36 in the file.
