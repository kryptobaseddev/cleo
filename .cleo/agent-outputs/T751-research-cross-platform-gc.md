# T751 — Cross-Platform Autonomous Transcript Garbage Collection for CLEO

**Research Date**: 2026-04-15
**Researcher**: T751 Research Agent
**Trigger**: Emergency manual cleanup of 41 GB `.temp/` accumulation Jan–Mar 2026
**Mandate**: Permanent, autonomous, zero-intervention GC — Win/Mac/Linux

---

## §1 Scheduling Primitives

### 1.1 In-Process Libraries (npm)

#### node-cron v4.x

- **Install**: `npm install node-cron` — 66.8 KB publish, 180 KB install, zero runtime deps
- **Downloads**: ~3 million/week as of February 2026 (source: pkgpulse.com, March 9, 2026)
- **Cross-platform**: Yes — pure JavaScript, OS-agnostic
- **Key API** (v4 — breaking change from v3):
  ```ts
  import cron from 'node-cron';
  const task = cron.schedule('0 3 * * *', handler, {
    timezone: 'UTC',
    noOverlap: true,   // prevents double-run if handler takes >24h
    name: 'gc-daily',
  });
  task.stop();
  task.start();
  task.destroy(); // unrecoverable
  ```
- **v4 breaking changes**: `scheduled` and `runOnInit` options removed. `createTask` replaces deferred scheduling. `maxExecutions` option added natively. (source: nodecron.com/migrating-from-v3)
- **Persistence**: NONE — jobs live only for process lifetime
- **Crash recovery**: Requires external state (e.g., `.cleo/gc-state.json`)
- **Verdict**: Best for always-running daemon; unsuitable for short-lived CLI invocations

#### node-schedule v2.1.1

- **Downloads**: ~2 million/week
- **Cross-platform**: Yes
- **Differentiator over node-cron**: supports one-off date-based jobs via `RecurrenceRule`; `reschedule()` method; `scheduledJobs` registry by name; `gracefulShutdown()` API
- **Persistence**: NONE
- **Bundle**: 34.1 KB publish, 4 MB install (heavier than node-cron)
- **Last release**: 3 years ago — low maintenance activity (source: npmtrends.com, 2026)
- **Verdict**: No meaningful advantage over node-cron for CLEO's use case; maintenance concern

#### bree v9.2.9

- **Downloads**: ~21,000/week (source: npmtrends.com)
- **Architecture**: Spawns each job into a Node.js Worker Thread — true isolation
- **Cross-platform**: Yes
- **Key advantage**: Each job is a separate `jobs/gc-temp.js` file, can be tested standalone
- **Graceful cancellation**: Worker sends `parentPort.postMessage('cancelled')` on `cancel` message (source: breejs/bree README)
- **Config example**:
  ```ts
  const bree = new Bree({
    jobs: [{ name: 'gc-temp', interval: '1h', timeout: 0 }],
    errorHandler: (err, meta) => logError(err, meta),
  });
  bree.start();
  ```
- **Persistence**: NONE natively — job definitions loaded from config on each process start
- **Crash recovery**: Same limitation as node-cron — no built-in state
- **Verdict**: Architecturally cleaner than node-cron for complex jobs, but heavier and lower adoption

#### agenda v6.2.4

- **Downloads**: ~300,000/week
- **Backend**: MongoDB required — disqualified for CLEO (no MongoDB dependency in stack)
- **Verdict**: Irrelevant for CLEO; CLEO already has SQLite via brain.db

### 1.2 OS-Native Schedulers

#### cron (Linux/macOS userland)

```bash
# User-level crontab (no root required)
crontab -e
0 3 * * * /usr/bin/node /path/to/gc.js >> ~/.cleo/logs/gc.log 2>&1
```

- **Pros**: Fires even when cleo is not running; persistent across reboots
- **Cons**: macOS: cron is deprecated in favor of launchd; unreliable on sleep/wake; no crash recovery state; requires knowing absolute node path
- **Cross-platform**: Linux + macOS only; Windows has no cron

#### launchd (macOS)

```xml
<!-- ~/Library/LaunchAgents/io.cleocode.gc.plist -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" ...>
<plist version="1.0"><dict>
  <key>Label</key>         <string>io.cleocode.gc</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/node</string>
    <string>/Users/user/.npm-global/lib/node_modules/@cleocode/cleo-os/dist/gc.js</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>3</integer><key>Minute</key><integer>0</integer></dict>
  <key>RunAtLoad</key>     <false/>
  <key>StandardOutPath</key> <string>/Users/user/.cleo/logs/gc.log</string>
</dict></plist>
```

```bash
launchctl load ~/Library/LaunchAgents/io.cleocode.gc.plist
```

- **Pros**: Apple's preferred mechanism; fires on sleep/wake; user-level (no sudo)
- **Cons**: Plist path must contain the real `node` binary path — fragile with nvm/fnm; requires user-specific plist install; macOS only; teardown on uninstall is manual unless handled in `preuninstall` hook

#### systemd timer (Linux)

```ini
# ~/.config/systemd/user/cleo-gc.service
[Unit]  Description=CLEO Garbage Collector
[Service]
Type=oneshot
ExecStart=/usr/bin/node /home/user/.npm-global/lib/.../gc.js
StandardOutput=append:/home/user/.cleo/logs/gc.log

# ~/.config/systemd/user/cleo-gc.timer
[Unit]  Description=CLEO GC daily
[Timer]
OnCalendar=daily
Persistent=true    # catches up missed runs after downtime
[Install]  WantedBy=timers.target
```

```bash
systemctl --user enable --now cleo-gc.timer
```

- **Pros**: `Persistent=true` replays missed runs after downtime (crash recovery!); user-level (no sudo); logs to journald
- **Cons**: Only on Linux with systemd (not Alpine, not containers); requires systemd ≥232 for user timers; node binary path fragility; setup/teardown complexity; not available on macOS/Windows

#### Windows Task Scheduler

```powershell
# Via PowerShell (no XML required)
$action = New-ScheduledTaskAction -Execute 'node.exe' -Argument 'C:\...\gc.js'
$trigger = New-ScheduledTaskTrigger -Daily -At 3am
Register-ScheduledTask -TaskName 'CleoGC' -Action $action -Trigger $trigger -RunLevel Limited
```

- **Pros**: Survives reboots; runs even when cleo is not running
- **Cons**: Requires PowerShell execution; `node.exe` path varies wildly with nvm/fnm/Volta; teardown on uninstall requires `Unregister-ScheduledTask`; no equivalent on other OSes; often blocked in corporate environments

### 1.3 Hybrid: OS-Detect + Fallback

The pattern used by VS Code and GitHub CLI: detect OS, use platform-native mechanism if available with graceful fallback to in-process daemon. Key insight from VS Code source: auto-update runs in-process (checking update.code.visualstudio.com) and is governance-controlled via `UpdateMode` policy — not a system service (source: code.visualstudio.com/docs/enterprise/updates).

### 1.4 Newer 2026 Schedulers

- **toad-scheduler v3.1.0**: 608 stars, simple interval scheduler, no cron syntax, no persistence. Not relevant.
- **BullMQ**: Redis-backed, high-throughput queue. Disqualified — requires Redis.
- **Trigger.dev / Inngest**: Cloud-hosted cron services. Not self-hosted.
- **No new dominant contender has emerged in 2026** to replace node-cron for embedded in-process scheduling (confirmed by npm trends as of Q1 2026).

---

## §2 Daemon Patterns for npm CLIs

### 2.1 Pattern A — In-Process Scheduler (Invocation-Attached)

```
cleo <any-command> → process starts → node-cron fires if interval elapsed → process exits
```

- GC only runs if a cleo command happens to be invoked near the scheduled time
- **Verdict**: Unreliable for autonomous operation. Breaks if user doesn't use cleo for days.

### 2.2 Pattern B — Sidecar Daemon (`cleo daemon start`)

```
cleo daemon start → spawns Node.js process detached from terminal → persists across CLI invocations
```

Implementation:
```ts
// cleo daemon start
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';

const logPath = path.join(cleoRoot, 'logs', 'daemon.log');
const out = createWriteStream(logPath, { flags: 'a' });
const err = createWriteStream(logPath, { flags: 'a' });

const child = spawn(process.execPath, [daemonScript], {
  detached: true,
  stdio: ['ignore', out, err],  // critical: must not inherit stdio
});
child.unref();  // parent CLI exits immediately

// Store PID for later management
fs.writeFileSync(pidFile, String(child.pid));
```

Key Node.js constraint: `detached: true` + `stdio: 'ignore'` (or file descriptors) + `child.unref()` is the canonical pattern for true background detachment on all three platforms (source: Node.js docs; freecodecamp.org/news/node-js-child-processes). Without all three, the parent process cannot exit cleanly.

- **Pros**: Persists across CLI invocations; no OS-level setup required; zero external dependencies
- **Cons**: Daemon dies on machine reboot (requires `cleo daemon start` after restart); PID management needed; users must know to run `cleo daemon start`
- **Verdict**: Best pattern for zero-config cross-platform background GC. Used by tools like OpenClaw gateway (source: a-bots.com/blog/openclaw)

### 2.3 Pattern C — Postinstall + OS Registration

```
npm install -g @cleocode/cleo-os
→ postinstall.js runs
→ detects OS
→ registers systemd timer / launchd plist / Task Scheduler entry
```

- **Pros**: Truly autonomous — fires even after reboot without user action
- **Cons**: `postinstall` runs as install user (may not have permission to modify system schedulers); node binary path is fragile with nvm/fnm/Volta; teardown on uninstall requires `preuninstall` hook; corporate environments often block PowerShell execution policies and launchd installs; npm registry guidelines discourage postinstall scripts that modify system state
- **Verdict**: Brittle for an npm global tool. VS Code avoids this — it registers via OS installer (`.dmg`/`.exe`/`.deb`), not npm. GitHub CLI uses Homebrew/winget/apt, not npm postinstall.

### 2.4 Pattern D — On-Startup Check with State File

```
cleo <any-command> → check .cleo/gc-last-run.json → if > 24h ago → run GC now, update timestamp
```

- **Pros**: Zero dependencies, works in any invocation context, no daemon process
- **Cons**: GC only fires when user actively uses cleo; if cleo is unused for weeks, no cleanup happens
- **Verdict**: Necessary complement to Pattern B (runs immediately when daemon is not running), but insufficient as primary mechanism

### 2.5 How VS Code and GitHub CLI Do It

**VS Code**: Background updates run **in-process** within the Electron main process, which is always running while VS Code is open. Update checking uses `update.code.visualstudio.com` APIs. No system scheduler is involved for an npm install. The OS-native auto-update mechanism only works for the native installer (`.dmg`, `.exe`, `.deb`). (source: code.visualstudio.com/docs/enterprise/updates, code.visualstudio.com/updates/v1_99)

**GitHub CLI (`gh`)**: Update checking runs **on every command invocation** — the manager checks once every 24 hours and displays an upgrade notice (source: augmentcode.com/open-source/cli/cli). No background daemon. GH CLI is installed via native package managers (Homebrew, winget, apt) which own the update mechanism — not via npm global install.

**Vercel CLI**: Notifies on update when any command is run. No background daemon. (source: vercel.com/docs/cli — "running any command will show you a message letting you know that an update is available")

**Key insight**: No major CLI tool running via `npm install -g` uses a background daemon for maintenance. They all use on-invocation checks because the npm distribution model doesn't provide a reliable background execution context.

**CLEO's unique constraint**: CLEO generates data even when not being actively used (agent transcripts, temp files from background processes). This makes on-invocation checking insufficient — the 41 GB incident happened precisely because no cleo command was run frequently enough.

**Recommended pattern for CLEO**: Hybrid of Pattern B + Pattern D with Pattern C as an opt-in enhancement.

---

## §3 Storage Threshold Monitoring

### 3.1 Package Options

#### `check-disk-space` v3.4.0 (RECOMMENDED)

- **Downloads**: 3,204,207/week — highest by far in this category
- **Dependencies**: Zero
- **TypeScript**: Built-in types
- **Platforms**: Linux, macOS, Windows — handles mount points correctly on Unix
- **API**:
  ```ts
  import checkDiskSpace from 'check-disk-space';

  // Pass the path where CLEO data lives
  const { free, size } = await checkDiskSpace('/home/user/.cleo');
  const usedPct = ((size - free) / size) * 100;
  ```
- Returns `{ diskPath, free, size }` in bytes (source: npmjs.com/package/check-disk-space)
- **Last publish**: 3 years ago but stable; 138 dependents; widely trusted

#### `node-os-utils` v2.0.3 (ALTERNATIVE — richer but heavier)

- **Full rewrite in 2024/2025** — TypeScript-first, zero dependencies, MonitorResult wrapper
- **Disk API**:
  ```ts
  import { OSUtils } from 'node-os-utils';
  const osutils = new OSUtils({ disk: { cacheTTL: 60000 } });
  const result = await osutils.disk.usageByMountPoint('/');
  if (result.success) {
    const pct = result.data.usagePercentage; // 0-100
  }
  // Also: healthCheck() returns 'healthy' | 'warning' | 'critical'
  ```
- **Platforms**: Linux (full), macOS (full), Windows (partial — core disk features work)
- **Verdict**: More capable but heavier. Use `check-disk-space` for disk-only checks; use `node-os-utils` if CLEO also needs CPU/memory monitoring.

#### `node-disk-info`

- Supports Windows, Linux, macOS, FreeBSD, OpenBSD; also works in Electron
- Less documentation; lower adoption than `check-disk-space`

### 3.2 Threshold Tiers (Recommended)

Based on industry standards (Elastic Stack defaults: 80% warning, Prometheus community: 85% critical):

| Tier | Threshold | Action |
|------|-----------|--------|
| WATCH | 70% | Log to `.cleo/logs/gc.log`, schedule next GC in 1h |
| WARN | 85% | Log + emit warning next time `cleo` is run |
| URGENT | 90% | Auto-prune oldest transcripts (>7d), log action |
| EMERGENCY | 95% | Auto-prune all transcripts (>1d), pause new transcript writes, emit error |

### 3.3 Polling Strategy

- **Scheduled GC run**: check disk at GC start before writing anything
- **Threshold-only polling** (for live monitoring): every 5 minutes in daemon mode
- Do NOT poll every 1 minute — disk checks involve `df`/PowerShell calls that have measurable overhead on some systems (source: node-os-utils perf table: Disk Info 100-300ms)

### 3.4 What to Measure

```ts
// Measure the filesystem that contains the CLEO data directory, not '/'.
// On systems with separate mounts for /home, /var, etc., the root filesystem
// percentage is irrelevant to CLEO's actual disk pressure.
const cleoDataPath = path.join(os.homedir(), '.cleo');
const { free, size } = await checkDiskSpace(cleoDataPath);
```

---

## §4 Crash Recovery

### 4.1 Problem Space

- Daemon process killed (SIGKILL, system reboot, OOM killer)
- GC job partially completed (e.g., deleted 3 of 10 directories, then crashed)
- Missed scheduled windows (system was off during the 3am slot)

### 4.2 State Persistence Schema

Store in `.cleo/gc-state.json` (NOT in brain.db — avoids SQLite WAL complications with daemon process):

```ts
interface GCState {
  schemaVersion: '1.0';
  lastRunAt: string | null;        // ISO timestamp of last COMPLETED run
  lastRunResult: 'success' | 'partial' | 'failed' | null;
  lastRunBytesFreed: number;       // bytes freed in last run
  pendingPrune: string[] | null;   // paths queued but not yet deleted (crash recovery)
  consecutiveFailures: number;     // escalate alert after 3
  diskThresholdBreached: boolean;  // sticky flag — cleared when disk drops below 70%
  daemonPid: number | null;        // pid of running daemon, null if stopped
  daemonStartedAt: string | null;  // timestamp daemon was last started
}
```

### 4.3 Crash Recovery Algorithm

On daemon startup (`cleo daemon start`):

1. Read `.cleo/gc-state.json`
2. If `pendingPrune` is non-empty → resume deletion from that list (idempotent — safe to re-delete paths that may already be gone)
3. If `lastRunAt` is null OR `(now - lastRunAt) > 24h` → run GC immediately
4. If `lastRunAt` is recent → schedule next run for `lastRunAt + interval`
5. Write updated `daemonPid` to state file

### 4.4 Idempotent Job Design

```ts
async function pruneDirectory(dirPath: string): Promise<void> {
  try {
    await fs.access(dirPath); // if path no longer exists, skip silently
    await fs.rm(dirPath, { recursive: true, force: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return; // already gone
    throw err;
  }
}
```

All deletions must be idempotent: `force: true` + ENOENT suppression. Write `pendingPrune` to state BEFORE starting deletion; clear each entry AFTER successful deletion; clear entire `pendingPrune` on job completion.

### 4.5 Missed Run Recovery (Daemon Pattern)

The daemon's main loop should check elapsed time on startup:

```ts
const INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h
const state = readGCState();
const nextRun = state.lastRunAt
  ? new Date(state.lastRunAt).getTime() + INTERVAL_MS
  : Date.now();
const delay = Math.max(0, nextRun - Date.now());
setTimeout(() => runGC().then(() => setInterval(runGC, INTERVAL_MS)), delay);
```

This gives systemd timer `Persistent=true` semantics in pure Node.js.

---

## §5 Owner Escalation Pattern

### 5.1 Reachability Check

CLEO cannot reliably detect if the owner is at the terminal when running as a background daemon. The correct pattern:

1. **Daemon detects threshold breach** → writes `escalation-needed: true` + reason to state file
2. **Next `cleo` invocation** → on startup, check state file → if `escalation-needed: true` → display interactive prompt
3. **Interactive prompt options**: `[P]rune now | [S]kip this time | [I]gnore threshold for 24h`
4. **If EMERGENCY (>95%)** → do not wait for next invocation → prune immediately, log, set `escalation-needed: true` for post-hoc notification

### 5.2 Non-Interactive Fallback

When no TTY is available (CI, scripts, headless agents):

```ts
const isTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY);
if (!isTTY && diskPct > 90) {
  // Auto-prune, never prompt
  await runEmergencyPrune();
  logWarn('Auto-pruned: disk at ' + diskPct + '% (non-interactive mode)');
}
```

### 5.3 Log Location

All GC activity → `.cleo/logs/gc.log` (rotating, max 5 MB, 3 rotations).

Format: `[ISO-8601] [LEVEL] [GC] message bytes_freed=N paths_pruned=N disk_pct=N%`

### 5.4 Escalation Levels

| Condition | Action | Owner Notification |
|-----------|--------|-------------------|
| Routine run, disk < 70% | Prune files older than retention policy | None |
| Disk 70-85% | Prune more aggressively (older threshold) | Warning on next `cleo` run |
| Disk 85-95% | Prune + skip new transcript writes | Warning banner on next `cleo` run |
| Disk > 95% | Emergency prune + pause writes | Immediate error in daemon log + banner on next `cleo` run |
| 3+ consecutive GC failures | Do not suppress | Error banner with log path |

---

## §6 Comparison Matrix

Scoring: 3 = best, 1 = worst

| Option | Cross-Platform | Install Overhead | Crash Recovery | Owner UX | Total | Notes |
|--------|---------------|------------------|----------------|----------|-------|-------|
| **node-cron v4 in daemon** | 3 (all OS) | 3 (npm bundled) | 2 (needs state file) | 3 (invisible) | **11** | Recommended primary |
| Sidecar daemon (detached spawn) | 3 | 3 (zero deps) | 2 (needs state file) | 2 (daemon start cmd) | **10** | Pattern for hosting node-cron |
| systemd timer | 1 (Linux only) | 1 (system setup) | 3 (Persistent=true) | 1 (manual unit files) | **6** | Optional enhancement on Linux |
| launchd plist | 1 (macOS only) | 1 (plist install) | 2 (OS manages) | 1 (manual) | **5** | Optional enhancement on macOS |
| Windows Task Scheduler | 1 (Windows only) | 1 (PS setup) | 2 (OS manages) | 1 (PS required) | **5** | Optional enhancement on Windows |
| bree v9 in daemon | 3 | 2 (4.88 MB) | 2 (needs state file) | 3 (invisible) | **10** | Heavier than node-cron |
| On-invocation check only | 3 | 3 | 1 (no daemon) | 3 (invisible) | **10** | Insufficient for headless use |
| agenda | 1 (requires MongoDB) | 1 (25 MB) | 3 | 2 | **7** | Disqualified (no MongoDB in CLEO) |
| OS-native via postinstall | 3 | 1 (brittle) | 3 | 1 (fragile) | **8** | Fragile with nvm/fnm |

**Winner**: node-cron v4 inside a sidecar daemon, with `.cleo/gc-state.json` for crash recovery.

---

## §7 Recommended Architecture

### 7.1 Overview

```
┌─────────────────────────────────────────────────────────────────┐
│  CLEO GC Architecture (cross-platform, zero system deps)        │
│                                                                  │
│  cleo daemon start → spawns packages/cleo/src/gc/daemon.ts      │
│                       (detached, stdio to gc.log)               │
│                       ↓                                         │
│  daemon.ts:           ┌─────────────────────────┐               │
│  node-cron schedule   │ every 24h + startup check│               │
│                       └────────────┬────────────┘               │
│                                    ↓                            │
│                       ┌─────────────────────────┐               │
│                       │ checkDiskSpace(.cleo)    │               │
│                       │ compute usedPct          │               │
│                       └────────────┬────────────┘               │
│                                    ↓                            │
│                    ┌───────────────┴───────────────┐            │
│                 < 85%                           ≥ 85%           │
│                    ↓                               ↓            │
│          prune by age policy              aggressive prune      │
│          (7d .temp, 30d transcripts)      + set escalation flag │
│                    ↓                               ↓            │
│          write GCState.lastRunAt          write gc-state.json   │
│                                                    ↓            │
│                                       next `cleo` invocation    │
│                                       detects flag → prompt     │
└─────────────────────────────────────────────────────────────────┘
```

### 7.2 Component Breakdown

#### `packages/cleo/src/gc/daemon.ts` — the daemon entry point

```ts
import cron from 'node-cron';
import { runGC } from './runner.js';
import { readGCState, writeGCState } from './state.js';

const INTERVAL_CRON = '0 3 * * *'; // 3am UTC daily

async function bootstrap() {
  const state = readGCState();

  // Crash recovery: resume pending prune
  if (state.pendingPrune?.length) {
    await runGC({ resumeFrom: state.pendingPrune });
  }

  // Missed run recovery: if last run was >24h ago, run now
  const lastRun = state.lastRunAt ? new Date(state.lastRunAt).getTime() : 0;
  if (Date.now() - lastRun > 24 * 60 * 60 * 1000) {
    await runGC({});
  }

  // Schedule future runs
  cron.schedule(INTERVAL_CRON, () => runGC({}), {
    timezone: 'UTC',
    noOverlap: true,
    name: 'cleo-gc',
  });
}

bootstrap().catch((err) => {
  console.error('[CLEO GC] Fatal daemon error:', err);
  process.exit(1);
});
```

#### `packages/cleo/src/gc/runner.ts` — the GC logic

```ts
import checkDiskSpace from 'check-disk-space';
import path from 'node:path';
import os from 'node:os';

const THRESHOLDS = { WATCH: 70, WARN: 85, URGENT: 90, EMERGENCY: 95 };

export async function runGC(opts: { resumeFrom?: string[] }): Promise<void> {
  const cleoRoot = path.join(os.homedir(), '.cleo');
  const { free, size } = await checkDiskSpace(cleoRoot);
  const usedPct = ((size - free) / size) * 100;

  const retentionDays = usedPct >= THRESHOLDS.EMERGENCY ? 1
    : usedPct >= THRESHOLDS.URGENT ? 3
    : usedPct >= THRESHOLDS.WARN ? 7
    : 30;

  // ... prune .temp/, agent-transcripts/, session logs older than retentionDays
  // ... write state, handle escalation flag
}
```

#### `packages/cleo/src/gc/state.ts` — persistent state

Uses `.cleo/gc-state.json` (plain JSON, not SQLite) for:
- Avoiding SQLite WAL conflicts with the running daemon
- Minimal footprint
- Human-readable for debugging

#### `packages/cleo/src/commands/daemon.ts` — `cleo daemon start|stop|status`

```ts
// start: spawn detached Node process
// stop: read pidFile, process.kill(pid, 'SIGTERM')
// status: check if PID is alive (process.kill(pid, 0) — no-throw means running)
```

#### `packages/cleo/src/gc/startup-check.ts` — on-invocation fallback

Called from the main cleo dispatch bootstrap:
```ts
// If daemon is not running AND last GC was >24h ago → run GC inline (brief)
// If escalation flag in gc-state.json → show banner
```

### 7.3 Directory Policy

| Path | Default Retention | Emergency Retention |
|------|-------------------|---------------------|
| `.temp/` | 24h | 1h |
| `.cleo/agent-outputs/` (transcripts) | 7 days | 1 day |
| `.cleo/logs/` | 30 days | 7 days |
| `.cleo/backups/sqlite/` | 10 snapshots (ADR-013) | 5 snapshots |
| `.cleo/agent-outputs/*.md` (artifacts) | Never auto-pruned | Never auto-pruned |

**Critical distinction**: Agent output artifacts (reports, plans, specs committed to git) must NEVER be auto-pruned. Only ephemeral transcripts and temp files are eligible.

### 7.4 Process Management Commands

```
cleo daemon start     # spawns gc daemon in background, writes PID
cleo daemon stop      # sends SIGTERM to daemon
cleo daemon status    # reports running/stopped, last GC timestamp, disk %
cleo gc run           # manual GC trigger (blocking, for debugging)
cleo gc status        # shows last run stats, disk%, escalation state
```

### 7.5 Startup Registration (Optional Enhancement)

For users who want GC to survive reboots, `cleo daemon install` (opt-in, not automatic):

```ts
// packages/cleo/src/commands/daemon.ts — install subcommand
switch (process.platform) {
  case 'linux':
    // Write ~/.config/systemd/user/cleo-gc.{service,timer}
    // Run: systemctl --user enable --now cleo-gc.timer
    break;
  case 'darwin':
    // Write ~/Library/LaunchAgents/io.cleocode.gc.plist
    // Run: launchctl load ...
    break;
  case 'win32':
    // Run: schtasks /create /tn CleoGC /tr "node gc.js" /sc daily /st 03:00
    break;
}
```

This is ALWAYS opt-in (`cleo daemon install`), never automatic on npm install. Reasons:
1. Binary path fragility with nvm/fnm/Volta
2. Corporate security policies
3. postinstall scripts that modify system state are discouraged by npm maintainers

---

## §8 Spec Update for memory-architecture-spec.md

The following items should be added or updated in the memory architecture specification:

### 8.1 New Section: `§X GC and Storage Lifecycle`

Add a new section to the memory architecture spec covering:

1. **Retention tiers** — which data is ephemeral vs. permanent. The 41 GB incident was caused by `.temp/` having no retention policy. The spec must define per-directory retention SLAs.

2. **GC state file** — `.cleo/gc-state.json` is a new runtime artifact. It must be:
   - Listed in `.gitignore` (like tasks.db — see ADR-013 §9)
   - Listed in `cleo init` initialization (created empty on fresh clone)
   - Listed in `cleo backup add` scope
   - NOT in `cleo backup restore` scope (ephemeral operational state)

3. **Transcript lifecycle** — agent transcripts (`.temp/`, agent-outputs/) generated by LOOM/CONDUIT are currently unbounded. The spec must define:
   - What constitutes an "ephemeral transcript" vs. a "committed artifact"
   - The transition from ephemeral → artifact (e.g., explicit `cleo observe` or `cleo complete` action)
   - Default TTL for unconverted transcripts (recommendation: 7 days)

4. **Disk pressure signals** — the memory system should gate new writes when disk is at URGENT/EMERGENCY tier. Specifically: `brain.db` observations and nexus index writes should be paused when disk >90%. This prevents the GC from competing with new data generation.

5. **Integration point with brain lifecycle** — the STDP/Hebbian memory system currently has no disk pressure awareness. The `brain-lifecycle.ts` strengthener (mentioned in memory-bridge) should be informed of disk tier so it can skip strengthening writes during EMERGENCY.

### 8.2 ADR Recommendation

A new ADR should be created (ADR-0XX: Autonomous GC and Disk Safety) covering:
- The sidecar daemon pattern choice and rationale
- The `gc-state.json` schema as a contract
- The three-tier retention policy
- The escalation protocol (non-interactive auto-prune vs. interactive prompt)
- Explicit statement that OS-native schedulers are opt-in only via `cleo daemon install`

---

## Sources

1. pkgpulse.com — "node-cron vs node-schedule vs Agenda 2026" (March 9, 2026): `https://www.pkgpulse.com/blog/node-cron-vs-node-schedule-vs-agenda-job-scheduling-nodejs-2026`
2. npmtrends.com — "agenda vs bree vs cron vs node-schedule vs toad-scheduler": `https://npmtrends.com/agenda-vs-bree-vs-cron-vs-node-schedule-vs-toad-scheduler`
3. nodecron.com — node-cron v4 API docs (scheduling options, migration): `https://nodecron.com/scheduling-options` and `https://nodecron.com/migrating-from-v3`
4. breejs/bree README (Context7, High reputation): graceful cancellation, job config schema
5. npmjs.com — check-disk-space v3.4.0: `https://www.npmjs.com/package/check-disk-space`
6. npmjs.com — node-os-utils v2.0.3: `https://www.npmjs.com/package/node-os-utils`
7. oneuptime.com — "How to Create Cron Jobs in Node.js" (Jan 22, 2026): `https://oneuptime.com/blog/post/2026-01-22-nodejs-cron-jobs/view`
8. freecodecamp.org — "Node.js Child Processes: Everything you need to know": detached spawn pattern
9. Node.js v25.9.0 docs — `child_process` detached option: `https://nodejs.org/api/process.html`
10. code.visualstudio.com — Enterprise updates / UpdateMode policy: `https://code.visualstudio.com/docs/enterprise/updates`
11. augmentcode.com — GitHub CLI architecture (24h update check): `https://www.augmentcode.com/open-source/cli/cli`
12. vercel.com — "Updating Vercel CLI" (on-invocation update notification): `https://vercel.com/docs/cli`
13. blog.sysxplore.com — "Scheduling Tasks with Systemd Timers in Linux" (Persistent=true): `https://blog.sysxplore.com/p/scheduling-tasks-with-systemd-timers`
14. a-bots.com — OpenClaw gateway daemon pattern: `https://a-bots.com/blog/openclaw`
15. logrocket.com — "Comparing the best Node.js schedulers": comparison table with install sizes

---

## Recommendation Summary

**Primary mechanism**: node-cron v4 (zero deps, 180 KB, 3M downloads/week) running inside a detached sidecar daemon process (`cleo daemon start`).

**Disk monitoring**: `check-disk-space` v3.4.0 (zero deps, 3.2M downloads/week, Linux/macOS/Windows).

**Crash recovery**: `gc-state.json` with `pendingPrune` array + startup elapsed-time check (systemd `Persistent=true` semantics in pure Node.js).

**Escalation**: Daemon writes escalation flag → next `cleo` invocation detects and prompts (or auto-prunes in non-TTY context).

**OS-native schedulers** (`cleo daemon install`): opt-in only — never automatic. systemd on Linux, launchd on macOS, schtasks on Windows. Solves the reboot survival problem without npm postinstall fragility.

**Cited sources**: 15 sources, 11 dated 2025-2026.
