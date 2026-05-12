# T1898 + T1901 — Sentient Daemon "Verified-Shipped" Audit

**Investigator:** read-only investigation agent
**Date:** 2026-05-11
**Project:** /mnt/projects/cleocode
**Verdict:** **NOT RUNNING in the cleocode project.** Production claim is false.

---

## 1. Current Operational State (verbatim)

### 1.1 `cleo sentient status` (cwd = /mnt/projects/cleocode)

```json
{
  "success": true,
  "data": {
    "running": false,
    "pid": null,
    "startedAt": "2026-04-21T05:05:46.090Z",
    "lastTickAt": "2026-04-21T05:05:46.092Z",
    "killSwitch": true,
    "killSwitchReason": "SIGTERM",
    "stats": { "tasksPicked": 0, "tasksCompleted": 0, "tasksFailed": 0,
               "ticksExecuted": 1, "ticksKilled": 1 },
    "stuckCount": 0,
    "supervisesStudio": true,
    "studioStatus": "stopped"
  }
}
```

The project-local sentient daemon for **/mnt/projects/cleocode has been dead since 2026-04-21** (20 days). `killSwitch=true`, `pid=null`. Nobody ever restarted it.

### 1.2 `cleo daemon status` (GC + hygiene unified view)

```json
{
  "gc":      { "running": false, "pid": null, "lastRunAt": null,
               "lastDiskUsedPct": null, "escalationNeeded": false },
  "hygiene": { "lastRunAt": null, "summary": null,
               "stats": { "projectsChecked": 0, "projectsHealthy": 0,
                          "tempGcCandidates": 0, "duplicateEpicGroups": 0,
                          "worktreesPruned": 0 } },
  "studio":  { "supervises": true, "status": "stopped" }
}
```

GC daemon also not running. Hygiene loop never executed in this project.

### 1.3 Project-local state file `/mnt/projects/cleocode/.cleo/sentient-state.json`

```
mtime: 2026-05-07 23:56  (touched by hygiene write — kept by global daemon?)
pid: null
startedAt: 2026-04-21T05:05:46.090Z
lastTickAt: 2026-04-21T05:05:46.092Z
killSwitch: true        ← never cleared
killSwitchReason: SIGTERM
ticksExecuted: 1
ticksKilled: 1
```

### 1.4 Project-local sentient log `/mnt/projects/cleocode/.cleo/logs/sentient.log`

Total 2 lines — both from the SAME boot attempt on 2026-04-20:

```
[CLEO SENTIENT] boot tick: error (task=n/a) picker threw: Search query or --id is required
[CLEO SENTIENT] boot tick: killed (task=n/a) killSwitch active before pick
```

The daemon CRASHED on its very first tick with `picker threw: Search query or --id is required`, the killSwitch was flipped, and it has not been started since.

### 1.5 `ps -ef | grep cleo` (running processes)

```
keatonh+    4663    4643  python3 /home/keatonhoskins/.local/bin/cleo-agent.py
```

**Only `cleo-agent.py` is running** — a Python SSE bridge to ClawMsgr ("cleo-bot"). That is **NOT** the sentient/dream daemon. Despite the misleading name `cleo-agent.service`, it is a chatbot relay, not the tick loop.

### 1.6 systemd user units installed

```
~/.config/systemd/user/cleo-agent.service          (Python SSE bridge — ACTIVE)
~/.config/systemd/user/cleo-sync.service           (disabled)
~/.config/systemd/user/cleo-sync.timer             (enabled)
```

The `cleo-daemon.service` that T1682's install-script generates (`SYSTEMD_UNIT_NAME = 'cleo-daemon'`, `ExecStart=cleo daemon start --foreground`) **has NEVER been installed on this machine.** The install-script lives at `/mnt/projects/cleocode/packages/cleo/scripts/install-daemon-service.mjs`, but no one has run `cleo daemon install` here.

### 1.7 Global daemon log `~/.local/state/cleo/daemon/cleo-daemon.log` (12,284 lines, mtime 2026-05-11 09:31:59)

Repeated boot/crash/restart cycle, e.g.:

```
{"level":"WARN","msg":"T310 migration startup check threw unexpectedly — CLI continues",
 "error":"Not inside a CLEO project. Run cleo init or cd to an existing project"}
{"data":{"pid":4833,"mode":"foreground","message":"Starting sentient daemon in foreground mode"}}
[CLEO STUDIO] Studio entrypoint not found at .../node_modules/@cleocode/studio/build/index.js
              — supervision disabled (not-available).
[CLEO DAEMON] Studio supervision enabled.
[CLEO SENTIENT] boot tick: no-task (task=n/a) no unblocked tasks available
[CLEO SENTIENT] tick: no-task (task=n/a) no unblocked tasks available
[CLEO SENTIENT] tick: no-task (task=n/a) no unblocked tasks available
... (many no-task ticks) ...
[CLEO DAEMON] Forwarding shutdown to Studio (SIGTERM)…
```

There is ALSO a "global" daemon that ran from `$HOME` (cwd-based projectRoot resolution) and wrote `~/.cleo/sentient-state.json` (`pid=null, startedAt=2026-05-11T14:40, lastTickAt=2026-05-11T16:30, ticksExecuted=2282`). It picks **zero** tasks (cwd has no tasks DB) and triggered the dream cycle **never** because volume/idle dream triggers in `maybeTriggerDream` depend on real per-project task picking and BRAIN content. That daemon **also died** at 09:31:59 (SIGTERM) and was not auto-restarted.

### 1.8 BRAIN consolidation events (cleocode project brain.db)

```
id | trigger      | started_at
---+--------------+--------------------
 7 | manual       | 2026-04-28 00:25:19
 6 | manual       | 2026-04-28 00:25:00
 5 | manual       | 2026-04-28 00:25:00
 4 | manual       | 2026-04-28 00:24:50
 3 | session_end  | 2026-04-24 19:01:01
 2 | session_end  | 2026-04-24 18:59:37
 1 | scheduled    | 2026-04-24 18:59:34
```

7 rows total. Last automated `session_end` was 2026-04-24 (17 days ago). 4 of 7 are manual. **No `scheduled`/`dream`/`autonomous` trigger has fired in 17 days.** The numbers in the bug report check out exactly.

The global brain.db (`~/.local/share/cleo/brain.db`) has **0** consolidation events, confirming the global-cwd daemon never produced anything useful either.

---

## 2. Root Cause

All four hypotheses (a)/(b)/(c)/(d) are partially true, but the **dominant** failures are (a)+(b)+(c):

| # | Hypothesis | Status | Evidence |
|---|------------|--------|----------|
| **(a)** | Daemon not actually started/running for cleocode | **TRUE — primary** | `cleo sentient status` reports `running=false, pid=null` since 2026-04-21. Last log line is the crashed boot-tick. No `daemon-entry` process in `ps -ef`. |
| **(b)** | T1682's systemd/launchd install did not happen on this machine | **TRUE — primary** | Only `cleo-agent.service` (the unrelated Python SSE bridge) is installed. The generated unit name from the installer is `cleo-daemon.service` — that file does not exist in `~/.config/systemd/user/`. T1682 was claimed shipped via `--override` evidence on a worktree branch; the install command was never executed on the operator's host. |
| **(c)** | Kill-switch active | **TRUE — primary** | Project-local state file: `"killSwitch": true, "killSwitchReason": "SIGTERM"`. Was set the moment the boot-tick crashed; nobody cleared it via `cleo sentient resume`. |
| **(d)** | `dreamCycle:null` disabling it via config | FALSE | `~/.cleo/config.json` has no `dreamCycle:null`. Tick code (tick.ts:906) honors null only when injected via `TickOptions` — not via config. Default is `safeRunDreamCycle` every 4 hours when `options.dreamCycle` is unset. |

### Why the global daemon also produced no dream consolidations

The global-cwd daemon (the one whose state lives at `~/.cleo/sentient-state.json` with 2282 ticks) ran in `--foreground` from `$HOME` because the systemd-style installer's generated unit file calls `cleo daemon start --foreground` with no `WorkingDirectory=` directive. The `--foreground` branch of `daemon start` (packages/cleo/src/cli/commands/daemon.ts:194) hard-codes `const projectRoot = process.cwd()` — so when launched from `$HOME` (or from systemd's default `$HOME` cwd), `projectRoot=/home/keatonhoskins` and there's no `.cleo/tasks.db` at that path. The picker returns no candidates, no task is ever picked, `maybeTriggerDream`'s idle counter ticks up, but the dream cycle ALSO targets `projectRoot` and finds an empty/non-existent brain.db. Hence: 2282 ticks, 0 dream cycles, 0 consolidation events in the global brain.db.

**The bug:** there is no daemon process scoped to /mnt/projects/cleocode AND the per-host systemd installation was never executed. T1682 + T1636's "verified-shipped" claims describe code that compiles but was never wired into running infrastructure. This is a textbook example of the override-evidence-on-worktree-branch failure mode the bug report names.

### Secondary code smell (not blocking, but flagged)

Per dream-trigger code (tick.ts:495-523):
- `dreamVolumeThreshold` default = 50
- `dreamIdleTicks` default = 5

These are workable defaults, but `maybeTriggerDream` calls `checkAndDream` (a *different* function from `safeRunDreamCycle`, imported from `@cleocode/core/internal`). The 4-hour-cron path (`maybeTriggerDreamCycleScan`, tick.ts:900-928) uses `safeRunDreamCycle` from `./dream-cycle.js`. These are TWO INDEPENDENT dream paths, not a single one — both must be running to fire scheduled and idle-volume dreams. Worth a follow-up audit.

---

## 3. Remediation Options (ranked by effort)

### Option 1 — Quick operational fix (minutes)

Just start the daemon in the project. No code change.

```bash
# 1. From /mnt/projects/cleocode — clear the stale kill-switch.
cd /mnt/projects/cleocode
cleo sentient resume          # clears killSwitch, does NOT spawn process

# 2. Spawn the detached sentient daemon for THIS project.
cleo sentient start            # background; writes .cleo/sentient.lock with new pid

# 3. Verify within ~10 seconds it ticked.
cleo sentient status           # expect running=true, lastTickAt within 5 min

# 4. Kill the rogue global-cwd daemon (if still alive).
# (Currently NOT alive — pid=null in ~/.cleo/sentient-state.json — so skip.)

# 5. Force a dream cycle to populate consolidation events immediately.
cleo memory dream --force      # or: cleo memory observe ... then wait for cron

# 6. Wait 4 hours (or set CLEO_DREAM_INTERVAL_MS=300000 to verify in 5 min).
sqlite3 .cleo/brain.db "SELECT trigger, started_at FROM brain_consolidation_events ORDER BY id DESC LIMIT 5;"
```

**Pros:** Fastest path to live behavior; surfaces any remaining code-level bugs.
**Cons:** Doesn't survive logout/reboot. Doesn't address the missing systemd install. Doesn't address the false-shipped claim in tasks/BRAIN.

### Option 2 — Code/config fix (root cause: T1682 + T1636 properly land)

1. **Run T1682's installer on this host** so the daemon actually auto-starts on login.

   ```bash
   cleo daemon install               # writes ~/.config/systemd/user/cleo-daemon.service
   systemctl --user enable --now cleo-daemon
   journalctl --user -u cleo-daemon -f   # verify boot is clean
   ```

2. **Fix the `--foreground` cwd bug** so the systemd unit actually targets a real project. Currently `daemon.ts:195` uses `process.cwd()`. Either:
   - (a) Add `WorkingDirectory=<projectRoot>` to the unit template in `install-daemon-service.mjs:buildSystemdUnit`, **OR**
   - (b) Add a `--project <root>` arg to `cleo daemon start` and have the installer write it into `ExecStart=`, **OR**
   - (c) Make the global daemon multi-project-aware (cycle through all registered projects per tick). T1637 (cross-project hygiene) already does this for hygiene — extend the same pattern to ticks.

   (c) is the principled fix and aligns with the existing hygiene cron's design.

3. **Verify the boot-tick crash is gone.** The "Search query or --id is required" error was supposedly fixed by T1187-followup (v2026.4.114). Run a fresh `cleo sentient start` and confirm the first log line is `boot tick: no-task` or `boot tick: success`, not `boot tick: error`.

4. **Re-verify T1682 and T1636 with HARD evidence (no `--override`):**
   ```bash
   cleo verify T1682 --gate implemented --evidence "commit:<sha>;files:packages/cleo/scripts/install-daemon-service.mjs"
   cleo verify T1682 --gate testsPassed --evidence "tool:pnpm-test"
   # AND: capture a screenshot/journalctl excerpt showing the unit is loaded/active on the host
   ```

**Pros:** Closes the operational gap and the code-quality gap. Future global-install upgrades pick up the daemon automatically.
**Cons:** Requires a code fix + a re-verify + a new release. ~1-2 days.

### Option 3 — Honest unship (file unship task, revert false claims)

If the operator does not want the daemon auto-running yet, revert the "verified-shipped" claim and re-open the work.

```bash
# 1. Reopen the falsely-shipped tasks.
cleo update T1682 --status pending --note "Reverting verified-shipped — systemd unit never installed on operator host; --override evidence was insufficient. See T1898 diagnosis."
cleo update T1636 --status pending --note "Reverting — daemon never ran in project, hygiene loop never fired. See T1898 diagnosis."

# 2. Add an acceptance criterion that forbids override-only verification.
cleo req add T1682 --kind acceptance --text "Daemon install verified by 'systemctl --user is-active cleo-daemon' returning 'active' on operator host (journalctl evidence attached)."

# 3. Record decision in BRAIN.
cleo memory observe "T1682+T1636 verified-shipped on --override evidence; daemon was never actually installed/running on the operator host. Unshipped on 2026-05-11 pending real install + reverify. Future bb-tt epics must reject --override for runtime-presence claims." --title "decision: no-override for runtime-presence gates"

# 4. File a follow-up task to actually do the install.
cleo add --kind work --type task --title "Install cleo-daemon systemd unit on operator host + verify dream cycle fires within 4h" --acceptance "systemctl is-active cleo-daemon = active | brain_consolidation_events row with trigger='scheduled' or 'dream' within 4h of install"
```

**Pros:** Restores ground truth. Tightens the verification protocol. No release pressure.
**Cons:** Re-opens completed work; visible-ledger churn.

---

## 4. Recommended Tier

**Tier 2 + Tier 3 in combination.**

- **Tier 3 first** (unship + new task) — restores ground truth in the task ledger and prevents future override-attacks of this shape.
- **Then Tier 2** — actually install + fix the `process.cwd()` projectRoot bug + re-verify with real evidence.
- **Tier 1 alone is insufficient** — it leaves the false-shipped claims standing and the next clone/login will still have no daemon.

If the orchestrator has only minutes available right now, Tier 1's commands give a healthy dream cycle in this project today; Tier 2/3 can follow asynchronously.

---

## 5. Concrete Next-Action Commands

```bash
# === Tier 1 quick fix (run NOW) ============================================
cd /mnt/projects/cleocode
cleo sentient resume
cleo sentient start
sleep 6
cleo sentient status                    # confirm running=true
cleo daemon status                      # confirm gc.running=true after start

# === Tier 3 honest unship (run NEXT) ======================================
cleo update T1682 --status pending --note "Reverted — see CLEANUP-2026-05-11/T1898-T1901-diagnosis.md"
cleo update T1636 --status pending --note "Reverted — see CLEANUP-2026-05-11/T1898-T1901-diagnosis.md"
cleo memory observe "T1682+T1636 unshipped: --override evidence insufficient for runtime-presence gates. Code compiled but daemon never installed/ran. See diagnosis." --title "decision: no-override for runtime-presence"

# === Tier 2 root-cause work (file as new task) ============================
cleo add \
  --kind work --type task \
  --title "Properly install + fix cleo-daemon: WorkingDirectory bug + reverify T1682+T1636" \
  --acceptance "systemctl --user is-active cleo-daemon = active | journalctl shows boot tick success | brain_consolidation_events gains a row with trigger='scheduled' or 'dream' within 4h" \
  --severity P1
```

---

## 6. Files Touched (read-only, no modifications)

- `/mnt/projects/cleocode/packages/core/src/sentient/tick.ts` (lines 264-276, 320-341, 490-524, 565-592, 880-928)
- `/mnt/projects/cleocode/packages/core/src/sentient/daemon.ts` (entire file — bootstrap, lock, cron schedule)
- `/mnt/projects/cleocode/packages/core/src/sentient/daemon-entry.ts`
- `/mnt/projects/cleocode/packages/core/src/sentient/daemon-api.ts` (entire file — public install/start/stop SDK)
- `/mnt/projects/cleocode/packages/core/src/sentient/dream-cycle.ts` (lines 1-80)
- `/mnt/projects/cleocode/packages/cleo/src/cli/commands/daemon.ts` (lines 170-211 — the `--foreground` cwd handler)
- `/mnt/projects/cleocode/packages/cleo/scripts/install-daemon-service.mjs` (lines 316-409 — systemd unit template + install)
- `/mnt/projects/cleocode/.cleo/sentient-state.json` (project-local state)
- `/mnt/projects/cleocode/.cleo/logs/sentient.log` (2-line crash log)
- `/home/keatonhoskins/.cleo/sentient-state.json` (global-cwd state; 2282 ticks, 0 picks)
- `/home/keatonhoskins/.local/state/cleo/daemon/cleo-daemon.log` (12,284 lines, crash-restart loop)
- `/home/keatonhoskins/.config/systemd/user/cleo-agent.service` (Python SSE bridge — NOT the sentient daemon)
- `~/.config/systemd/user/cleo-daemon.service` — **MISSING** (the file T1682 should have produced)
