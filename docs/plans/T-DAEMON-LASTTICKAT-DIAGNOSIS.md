# Sentient Daemon — stale `lastTickAt` diagnosis & remediation plan

**Status**: Draft (investigation complete, fix scope proposed)
**Created**: 2026-05-15
**Owner**: cleo-prime
**Related**: ADR (TBD), T9261 phase 4 follow-up
**Related task** (harness): #3

---

## 1. Observed symptom

`cleo sentient status` reports `running: true, pid: 3213326, ticksExecuted: 163`
but `lastTickAt: 2026-05-13T23:50:00.103Z` — **~26 hours stale** vs. wall
clock `2026-05-15T01:38:00Z`. The process is alive (verified via `ps`, RSS
~862 MB, 11 threads) but the Tier-1 cron has not advanced state for over a
day.

## 2. Architecture under investigation

```
spawnSentientDaemon()           detached child
  └─ daemon-entry.ts            bootstrapDaemon(projectRoot)
       └─ daemon.ts             cron.schedule(SENTIENT_CRON_EXPR, ...)
            └─ tick.ts          safeRunTick(options) → runTick()
                 └─ dream-cycle.ts  safeRunDreamCycle (volume/idle triggers)
                       └─ memory/sleep-consolidation.ts
                            └─ fetch('https://api.anthropic.com/v1/messages')
```

| Component | Value |
|---|---|
| Tier-1 cron expr | `*/5 * * * *` (every 5 min on the boundary) |
| Tier-2 cron expr | `0 */2 * * *` (disabled by default) |
| Hygiene cron expr | `0 2 * * *` |
| `noOverlap` flag | `true` on all three crons |
| `node-cron` version | **4.2.1** |
| State file | `.cleo/sentient-state.json` |
| Log file | `.cleo/logs/sentient.log` (no timestamps in entries) |

## 3. Evidence

| Artifact | Reading |
|---|---|
| state.json mtime | `2026-05-13 16:50:00.123 -0700` (23:50:00 UTC) |
| sentient.log mtime | `2026-05-13 16:50:00.125 -0700` (23:50:00 UTC, +2ms) |
| `lastTickAt` in state | `2026-05-13T23:50:00.103Z` |
| `startedAt` in state | `2026-05-13T23:44:51.809Z` |
| Boot tick → last tick | **5 min 9 s** (≈ one full Tier-1 interval) |
| Process state | alive, ~862 MB RSS, 11 threads, no zombie children |
| `ticksExecuted` counter | 163 — **cumulative across restarts** (state persists across reboots) |
| Inline brain ticks | `cleo briefing` still runs `[plasticity]` + `[prune-sweep]` + `[sleep-consolidation]` from the calling process (NOT the daemon) |
| Sleep-consolidation status | every attempt → `401 Invalid` (no Anthropic credentials configured) |

**Key inference**: log and state froze at the **same millisecond** — within the
single cron-callback write window. After that millisecond, no tick fires. So
the cron callback either (a) never fires again, or (b) fires but its first
async step hangs forever before any write.

## 4. State-write coverage in `runTick` (audited)

Every exit branch in `packages/core/src/sentient/tick.ts:runTick` writes
`lastTickAt` before returning:

| Branch | Line | Writes lastTickAt |
|---|---|---|
| killSwitch before pick | 572 | ✅ |
| picker threw | 584 | ✅ |
| no task | 590 | ✅ |
| backoff | 599 | ✅ |
| killSwitch before spawn | 610 | ✅ |
| killSwitch after spawn | 640 | ✅ |
| re-verify rejected | 680 | ✅ |
| success | 702 | ✅ |
| stuck-task path | 750 | ✅ |
| tail / unhandled | 786 | ✅ |

Conclusion: if `runTick` returns at all, `lastTickAt` updates. So the daemon's
problem is **upstream of any runTick exit** — the tick handler either never
fires, or hangs inside an `await` before reaching any state-write line.

## 5. Root-cause hypotheses (ranked by likelihood)

### H1 — node-cron 4.x `noOverlap` lock leaks (HIGH)

`node-cron@4.2.1` redesigned scheduling. With `noOverlap: true`, the runner
acquires an internal lock around the callback. If the callback's promise
rejects via an *unhandled* path (e.g., a synchronous throw inside an async
function before any `await`, or `process.stdout.write` racing on EPIPE during
shutdown), the lock can fail to release. Subsequent scheduled invocations are
silently skipped. The library logs nothing.

**Why it fits**: state freeze is exactly on the cron boundary; no error in
log; process alive; ticks stop forever after one good cycle. node-cron v3→v4
is a relatively recent upgrade in this repo — high churn surface.

### H2 — Brain DB lock contention with inline callers (MEDIUM)

The Tier-1 tick (via dream-cycle volume/idle triggers) calls into
`memory-sqlite` to read observations. Meanwhile every `cleo briefing`,
`cleo memory observe`, `cleo complete` from the terminal process opens its
own brain.db handle (better-sqlite3 with mmap). If a stale exclusive lock
holds the WAL, the daemon's next tick blocks forever on its first SQLite
prepare. Better-sqlite3 has no default busy timeout — operations block
indefinitely unless `PRAGMA busy_timeout` is set.

**Why it fits**: ~862 MB RSS suggests a held SQLite mmap region; user runs
many terminal-side `cleo` commands.

**Why it's only medium**: the inline tick output we see *during* the
investigation (`[plasticity]`, `[prune-sweep]`) succeeds, suggesting the
brain DB is currently *openable* from a fresh process.

### H3 — Unawaited handle in `runSleepConsolidation` (MEDIUM)

`sleep-consolidation.ts` dynamically imports `memory-sqlite` and opens
`brain.db` four times per pass (once per step). When the LLM call 401s
mid-pass, error handling returns early — but the SQLite handle may not be
explicitly closed. Over many failed runs the handle pool can exhaust, then
the next `getBrainDb()` blocks. The 30-second `AbortSignal.timeout` on the
fetch only covers the HTTP path, not subsequent DB operations.

### H4 — Process is alive but cron timer was GC'd (LOW)

If no strong reference to the cron `ScheduledTask` is retained,
`node-cron@4.x` (which uses `setTimeout` internally) could in theory let
the timer be cleared by the runtime's idle-handle reaper. However daemon.ts
keeps the cron schedules implicitly via closure capture, so this should not
fire — listed only for completeness.

## 6. Reproduction steps

To verify *which* hypothesis holds, run from a clean state:

```bash
# 1. Snapshot current state
cp .cleo/sentient-state.json /tmp/state-before.json
cleo sentient status --json > /tmp/status-before.json

# 2. Restart daemon clean (kill + clear state)
cleo daemon stop
rm -f .cleo/sentient-state.json
rm -f .cleo/logs/sentient.log
cleo daemon start

# 3. Watch for 15 minutes — should see at least 3 tick lines
tail -f .cleo/logs/sentient.log &
sleep 900
cleo sentient status --json | jq '.data.lastTickAt'

# 4. While waiting, hit brain.db hard from terminal to stress H2
for i in {1..50}; do cleo briefing >/dev/null; done

# 5. If lastTickAt freezes, capture node process state
node --inspect-port=9229 -p 'process.pid'  # find daemon pid first
kill -USR1 <pid>   # node SIGUSR1 enables inspector
# Then connect chrome://inspect to walk the event loop
```

## 7. Proposed fix scope

Implement in this order — each step independent and shippable.

### Step A — Add heartbeat instrumentation (15 min, no behavior change)

In `daemon.ts` cron callback, write a `pre-tick` heartbeat *before* invoking
`safeRunTick`:

```ts
cron.schedule(SENTIENT_CRON_EXPR, async () => {
  await patchSentientState(statePath, {
    lastCronFiredAt: new Date().toISOString(),  // NEW field
  });
  const result = await safeRunTick(tickOptions);
  // ... existing log write
});
```

Add `lastCronFiredAt: string | null` to `SentientState` schema. This
distinguishes **"cron didn't fire"** (no heartbeat) from **"cron fired but
runTick hung"** (heartbeat advanced, lastTickAt stale).

Also add ISO timestamps to every `process.stdout.write` so
`sentient.log` becomes correlation-friendly:

```ts
process.stdout.write(`${new Date().toISOString()} [CLEO SENTIENT] tick: ...\n`);
```

### Step B — Defensive lock release (30 min, low risk)

Wrap the cron callback body to guarantee the noOverlap lock releases:

```ts
cron.schedule(SENTIENT_CRON_EXPR, async () => {
  try {
    await patchSentientState(statePath, { lastCronFiredAt: new Date().toISOString() });
    const result = await safeRunTick(tickOptions);
    process.stdout.write(`${new Date().toISOString()} [CLEO SENTIENT] tick: ${result.kind} ...\n`);
  } catch (err) {
    // never let a callback rejection take down node-cron's scheduler
    process.stderr.write(`${new Date().toISOString()} [CLEO SENTIENT] tick error: ${err}\n`);
  }
}, { timezone: 'UTC', noOverlap: true, name: 'cleo-sentient' });
```

`safeRunTick` already catches; this is belt-and-braces.

### Step C — SQLite busy_timeout pragma (20 min, low risk)

In `packages/core/src/store/memory-sqlite.ts`, set
`PRAGMA busy_timeout = 5000` on every brain.db handle open. Better-sqlite3
defaults to 0 (block forever); a 5 s timeout converts hangs into recoverable
`SQLITE_BUSY` errors that can be retried or logged.

Confirm same pragma on `tasks.db` open path.

### Step D — Explicit handle cleanup in sleep-consolidation (30 min, low risk)

In each of the four steps of `runSleepConsolidation`, wrap the
`getBrainNativeDb()` use in a `try { ... } finally { /* no-op today */ }`
pattern and audit whether the handle is reference-counted or singleton.
If singleton, no cleanup needed — but document that explicitly.

### Step E — Tick watchdog (1 hr, medium risk)

Add a wall-clock watchdog: separate `setInterval` (NOT cron) checks every 60 s
whether `lastCronFiredAt` is older than `2 × interval`. If so, log a fatal
warning and either (i) `process.exit(1)` so the parent harness/launchd
restarts the daemon, or (ii) attempt to re-schedule the cron job by name.
Option (i) is safer.

### Step F — Evaluate downgrade to node-cron@3.x (optional, defer)

If H1 is confirmed after Steps A+B and node-cron upstream has no fix,
consider pinning to `node-cron@^3.0.3` (the last v3 release before the
overlap-lock semantics changed). Track in a separate task.

## 8. Acceptance criteria for the fix

1. After daemon restart, `lastCronFiredAt` advances every 5 minutes for at
   least 1 hour of observation.
2. `lastTickAt` and `lastCronFiredAt` agree to within 1 second when
   `runTick` exits cleanly.
3. Forcing a hang inside the tick (test injection that returns a never-
   resolving promise) results in `lastCronFiredAt` advancing while
   `lastTickAt` stays frozen — Step A's instrumentation works.
4. Tests in `packages/core/src/sentient/__tests__/` all pass.
5. `cleo sentient status` envelope includes the new `lastCronFiredAt`
   field without breaking any existing JSON consumer.

## 9. Out of scope

- The root cause of the 401 sleep-consolidation errors is a separate
  workstream (T-LLM-CRED Phase 4 — unhardcode brain LLM call sites,
  harness task #2). The daemon hang plan above is provider-agnostic and
  must hold regardless of which LLM the brain ends up using.
- Tier-2 propose loop reactivation (currently disabled by default) is also
  separate.

## 10. Open questions for owner

1. Is the daemon currently restartable safely (any in-flight work
   inside PID 3213326 we shouldn't lose), or should we just
   `cleo daemon stop && cleo daemon start` and observe with the new
   instrumentation?
2. Preference between watchdog options (i) self-exit vs (ii) self-recover?
   Self-exit is simpler and aligns with the rest of CLEO's "let the harness
   restart on fatal" pattern.
