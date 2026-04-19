# Sentient Loop — Tier 1 Operator Guide

The sentient daemon is a background sidecar that autonomously executes
unblocked tasks from your project's task graph. Tier 1 is the only tier
currently shipped. Tier 2 (propose) and Tier 3 (sandbox auto-merge) are
scoped for a later release.

## What Tier 1 does

- Every 5 minutes it picks the next unblocked task (status `pending`, all
  dependencies satisfied, not a `proposed` Tier-2 entry) and spawns a worker
  via `cleo orchestrate spawn <taskId> --adapter claude-code`.
- Successful spawns write a receipt to `brain.db` via `memory.observe`.
- Failed spawns retry with 30 s / 5 min / 30 min backoff. After 3 failures
  the task is marked **stuck** and requires owner intervention.
- If 5 tasks become stuck within a rolling 1-hour window the daemon
  **self-pauses** (flips `killSwitch=true`) and waits for the owner.
- The daemon re-checks the kill switch at **every step** of a tick —
  picking, spawning, and recording — so stopping it never leaves you in a
  mid-experiment limbo.

## What Tier 1 does NOT do

- **Propose new tasks.** `status='proposed'` is reserved for the future
  Tier-2 queue. The picker filters it out, so you can already tag tasks
  with that status and know the loop will never run them.
- **Auto-merge sandbox work.** Tier 3 will gate PRs by externally-anchored
  baselines and is blocked on sandbox infrastructure.
- **Sign receipts with Ed25519.** Cryptographic signing lives in the
  llmtxt/identity stack (Agent B2) and the daemon will call those helpers
  once available.

## Starting the daemon

```bash
cleo sentient start
```

This spawns a detached Node.js process that persists across CLI
invocations (PID recorded in `.cleo/sentient-state.json`). Logs stream to
`.cleo/logs/sentient.log` and `.cleo/logs/sentient.err`.

To verify without starting a long-lived process, run a single tick:

```bash
cleo sentient start --dry-run
# or, without scheduling anything:
cleo sentient tick --dry-run
```

## Stopping the daemon

```bash
cleo sentient stop
```

This flips `killSwitch=true` FIRST and then sends `SIGTERM`. An in-flight
tick notices the flag on its next checkpoint and exits cleanly — the
worker subprocess will finish its current attempt, but no new attempt is
started and no state is recorded beyond what the current step completes.

To resume after a self-pause or a manual stop:

```bash
cleo sentient resume
```

That clears the kill switch. If the process itself was terminated you
must re-run `cleo sentient start`.

## Inspecting status

```bash
cleo sentient status
```

Example output:

```
Daemon:       running (pid 13892)
Started at:   2026-04-17T18:22:01.412Z
Last tick:    2026-04-17T18:27:01.801Z
Kill switch:  inactive
Active task:  none
Stuck tasks:  0
Stats:        picked=14 completed=13 failed=1 ticks=20 killed-ticks=0
```

Add `--json` for a LAFS envelope suitable for scripting.

## State file

`.cleo/sentient-state.json` is the single source of truth for daemon
state. It contains the PID, kill-switch flag, rolling stats, per-task
retry backoff, and the stuck-detection window. The file is gitignored
and is considered ephemeral operational state (not part of `cleo backup
restore` scope).

## Rate limit

Tier 1 ticks on a `*/5 * * * *` cron. That is a hard cap of 12 ticks per
hour and therefore ≤ 12 worker spawns per hour per project. The cadence
is inherent to the scheduler — no separate throttle is needed.

## Rollback

If you need to fully disengage:

```bash
cleo sentient stop
cleo session end --note "disengaging sentient loop"
```

`cleo sentient stop` is idempotent. Running it twice is safe: it sets
the kill switch to `true` on each call and will report "already dead"
for a PID that is no longer live.

## Scoped-out features (future work)

- **Tier 2 — propose:** a separate CLI (`cleo propose`) and a proposal
  queue using `status='proposed'` will land in a follow-up epic. The
  enum value is already reserved and the picker already filters it, so
  upgrading does not require a schema migration.
- **Tier 3 — sandbox auto-merge:** requires agent-in-container
  execution + externally-anchored baselines per the Round 2 audit and
  is blocked on sandbox infrastructure work.
- **Ed25519 receipt signing:** currently the daemon writes an unsigned
  `memory.observe` receipt for every success / failure. Once the
  llmtxt/identity wiring ships, the daemon will call the signing helper
  for every receipt without changing its public surface.

See `ADR-054` for the design rationale.
