---
id: ADR-047
title: "ADR-047: Autonomous GC and Disk Safety — Sidecar Daemon + Transcript Lifecycle"
status: accepted
date: 2026-04-15
authors: ["cleo-subagent Worker-C (T726 Wave 1C)"]
related_tasks: ["T726", "T731", "T728", "T735", "T751"]
supersedes: null
amends: "ADR-013"
summary: "Adopts a node-cron v4 sidecar daemon (Pattern B from T751 research) as the primary cross-platform GC mechanism. Defines gc-state.json as the crash-recovery contract, five disk-pressure tiers (ok/watch/warn/urgent/emergency), the hot/warm/cold transcript lifecycle model, and the escalation banner protocol. OS-native schedulers (systemd/launchd/schtasks) are deferred as opt-in via 'cleo daemon install'."
keywords: ["gc", "garbage-collection", "transcript", "disk-safety", "daemon", "node-cron", "lifecycle"]
topics: ["storage", "admin", "memory", "transcripts", "disk"]
---

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT",
"RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in RFC 2119.

---

## 1. Context and Problem Statement

### 1.1 The Incident

Between January and March 2026, CLEO accumulated 41 GB of ephemeral Claude session transcripts
in `~/.claude/projects/` with zero automatic cleanup. The accumulation was caused by:

1. **No GC policy**: No retention policy existed for `~/.claude/projects/` or `~/.temp/` directories.
2. **Unbounded transcript writes**: Every LOOM/CONDUIT agent session writes JSONL transcripts. With
   hundreds of agents running in parallel (Phase 7 T377), the volume compounds rapidly.
3. **No disk pressure detection**: The system had no awareness of filesystem utilization.

### 1.2 Scope

This ADR covers:
- The scheduling mechanism for autonomous cleanup (which library/pattern to use)
- The `gc-state.json` schema as a crash-recovery contract
- The five-tier disk threshold model
- The hot/warm/cold transcript lifecycle definition
- The escalation protocol (daemon-to-CLI communication)
- CLI surface (`cleo daemon start/stop/status`, `cleo gc run/status`, `cleo transcript scan/extract/prune`)

---

## 2. Decision

### 2.1 Primary Mechanism: node-cron v4 Sidecar Daemon

**Decision**: Use node-cron v4 running inside a detached sidecar daemon process as the primary
autonomous GC scheduling mechanism.

**Rationale** (from T751 cross-platform GC research, §6 comparison matrix):

| Option | Cross-Platform | Install Overhead | Crash Recovery | Score |
|--------|---------------|------------------|----------------|-------|
| node-cron v4 in daemon | 3 (all OS) | 3 (npm bundled) | 2 (state file) | **11** |
| systemd timer | 1 (Linux only) | 1 (system setup) | 3 | 6 |
| launchd plist | 1 (macOS only) | 1 (plist) | 2 | 5 |
| Windows Task Scheduler | 1 (Windows only) | 1 (PS) | 2 | 5 |

node-cron v4 is the clear winner for a cross-platform npm global tool:
- Zero runtime dependencies, 180 KB install size
- ~3 million downloads/week (Q1 2026)
- `noOverlap: true` option prevents double-runs if handler takes > 24h
- Works identically on Linux, macOS, and Windows

**Why not OS-native schedulers as the primary mechanism?**

No major CLI tool running via `npm install -g` uses OS-native schedulers as the primary mechanism
because of binary path fragility with nvm/fnm/Volta and corporate security policies blocking
PowerShell and launchd installs. VS Code uses in-process updates in the Electron main process;
GitHub CLI uses on-invocation update checks. Neither uses npm postinstall system registration.

CLEO's unique constraint is that transcripts accumulate even when no `cleo` command is run
(background agent sessions). This makes on-invocation-only checks insufficient — hence the
sidecar daemon as the primary mechanism, with on-invocation check as a fallback.

### 2.2 Spawn Pattern (Pattern B from T751 §2.2)

The sidecar daemon MUST be spawned with all three required flags:

```typescript
const child = spawn(process.execPath, [daemonEntry, cleoDir], {
  detached: true,                          // (1) process group leader
  stdio: ['ignore', outStream, errStream], // (2) file-based stdio (not TTY)
  env: { ...process.env },
});
child.unref(); // (3) parent CLI exits immediately
```

Without all three: `detached: true` (process group leader), file stdio (not inherited TTY),
and `child.unref()` (parent exits), the parent CLI cannot exit cleanly.

### 2.3 gc-state.json — Crash Recovery Contract

The state file MUST be stored at `.cleo/gc-state.json` (plain JSON, not SQLite) because:
- Avoiding SQLite WAL conflicts between the long-running daemon and the main CLI process
- Human-readable for debugging without a SQLite client
- Trivially parseable by bash/PowerShell for external monitoring

**Schema (version 1.0)**:

```typescript
interface GCState {
  schemaVersion: '1.0';
  lastRunAt: string | null;              // ISO-8601, last COMPLETED run
  lastRunResult: 'success' | 'partial' | 'failed' | null;
  lastRunBytesFreed: number;
  pendingPrune: string[] | null;         // crash-recovery queue
  consecutiveFailures: number;
  diskThresholdBreached: boolean;        // sticky, cleared when disk < 70%
  lastDiskUsedPct: number | null;
  escalationNeeded: boolean;             // cleared by CLI after banner display
  escalationReason: string | null;
  daemonPid: number | null;
  daemonStartedAt: string | null;
}
```

**Crash recovery algorithm**:
1. Write paths to `pendingPrune` BEFORE starting deletion
2. Remove each path from `pendingPrune` AFTER successful deletion (idempotent)
3. Clear `pendingPrune` entirely when job completes
4. On daemon startup: if `pendingPrune` non-empty → resume from that list
5. On daemon startup: if `(now - lastRunAt) > 24h` → run immediately (missed-run recovery)

This gives `systemd Persistent=true` semantics in pure Node.js.

### 2.4 Five-Tier Disk Threshold Model

Based on industry standards (Elastic Stack: 80% warning; Prometheus community: 85% critical):

| Tier | Threshold | Action |
|------|-----------|--------|
| OK | < 70% | Routine prune by age policy (30d). No escalation. |
| WATCH | 70–85% | Log to gc.log. Schedule next GC sooner. |
| WARN | 85–90% | Log + set `escalationNeeded=true` in gc-state.json. |
| URGENT | 90–95% | Auto-prune oldest transcripts (>7d). Log action. |
| EMERGENCY | ≥ 95% | Auto-prune all transcripts (>1d). Log. Escalation immediately. |

**Retention mapping** (higher pressure → shorter retention):

| Tier | Transcript retention |
|------|---------------------|
| OK / WATCH | 30 days |
| WARN | 7 days |
| URGENT | 3 days |
| EMERGENCY | 1 day |

### 2.5 Hot/Warm/Cold Transcript Lifecycle (Three-Tier Model)

```
HOT  (0–24h)    Full JSONL retained. Agents can re-read. Not eligible for GC.
WARM (1–7d)     Pending extraction. Eligible for GC after extraction (or at 7d).
COLD (>7d)      brain.db entries only. Raw JSONL deleted. Tombstone in brain_observations.
```

**Storage layout** (`~/.claude/projects/<slug>/`):
- Root-level `<session-uuid>.jsonl` — main session transcript (HOT/WARM)
- `<session-uuid>/subagents/agent-*.jsonl` — subagent transcripts (HOT/WARM)
- `<session-uuid>/tool-results/*.json` — raw tool results (deleted with session dir)

**What is NEVER auto-pruned**:
- `.cleo/agent-outputs/*.md` committed artifact files (reports, plans, specs)
- Long-tier brain.db entries
- `.cleo/backups/sqlite/` snapshots (managed by ADR-013 rotation policy)

### 2.6 Escalation Protocol (Daemon-to-CLI Communication)

The daemon cannot reliably detect whether the owner is at the terminal. The correct pattern:

1. **Daemon detects threshold breach** → writes `escalationNeeded=true` + reason to gc-state.json
2. **Next `cleo` invocation** → startup check reads gc-state.json → if `escalationNeeded=true` → shows banner
3. **Interactive prompt options**: `cleo gc run` to prune immediately
4. **EMERGENCY (≥ 95%)** → daemon auto-prunes immediately (does not wait for next invocation)
5. **Non-TTY context** → auto-prune without prompt at URGENT/EMERGENCY; log action

### 2.7 OS-Native Schedulers — Opt-In Only

OS-native schedulers (systemd timers, launchd plists, Windows Task Scheduler) are available
via `cleo daemon install` but are NEVER installed automatically. Reasons:
1. Binary path fragility with nvm/fnm/Volta (node path varies per user)
2. Corporate security policies often block PowerShell execution and launchd installs
3. npm postinstall scripts that modify system state are discouraged by npm maintainers
4. Teardown complexity: `preuninstall` hooks are unreliable in npm global install

The systemd unit files specified in memory-architecture-spec.md §8.2 are provided in
`packages/caamp/src/platform/linux/` for users who opt in, but are not installed by default.

---

## 3. Consequences

### 3.1 Positive

- **Cross-platform**: Works identically on Linux, macOS, and Windows
- **Zero system dependencies**: node-cron v4 and check-disk-space v3 are bundled npm deps
- **Crash recovery**: `pendingPrune` state provides `systemd Persistent=true` semantics
- **Operator visibility**: `cleo daemon status` and `cleo gc status` expose all state
- **Escalation safety**: Escalation banner on next CLI invocation; auto-prune only in non-TTY

### 3.2 Negative / Trade-offs

- **No reboot survival**: Daemon process does not survive machine reboots (requires `cleo daemon start`
  after restart). Users who want reboot-persistent GC must use `cleo daemon install` (opt-in).
- **Daemon must be started manually**: `cleo daemon start` must be run once per boot. Future work
  could add a `cleo init` prompt or a shell profile injection.

### 3.3 Files Changed

| Path | Change |
|------|--------|
| `packages/cleo/src/gc/state.ts` | New — GCState schema, read/write/patch |
| `packages/cleo/src/gc/runner.ts` | New — GC execution (disk check, prune, state update) |
| `packages/cleo/src/gc/daemon.ts` | New — Spawn/stop/status + bootstrap loop |
| `packages/cleo/src/gc/daemon-entry.ts` | New — Standalone daemon script entry point |
| `packages/cleo/src/gc/transcript.ts` | New — scan/prune/parseDuration for T728 |
| `packages/cleo/src/cli/commands/daemon.ts` | New — `cleo daemon start/stop/status` |
| `packages/cleo/src/cli/commands/gc.ts` | New — `cleo gc run/status` |
| `packages/cleo/src/cli/commands/transcript.ts` | New — `cleo transcript scan/extract/prune` |
| `packages/cleo/src/cli/index.ts` | Modified — register 3 new commands |
| `.gitignore` | Modified — add gc-state.json, gc.log, gc.err |
| `packages/cleo/package.json` | Modified — add node-cron@^4, check-disk-space@^3 |

### 3.4 Runtime Artifacts (gitignored per ADR-013 §9 extension)

| Path | Status | Rationale |
|------|--------|-----------|
| `.cleo/gc-state.json` | gitignored | Ephemeral operational state — NOT restored from backup |
| `.cleo/logs/gc.log` | gitignored | Daemon stdout (already covered by `.cleo/logs/`) |
| `.cleo/logs/gc.err` | gitignored | Daemon stderr (already covered by `.cleo/logs/`) |

`gc-state.json` is created empty by `cleo init` and does NOT need `cleo backup restore` support.
It is safe to delete: the next daemon startup will recreate it with defaults.

---

## 4. Compliance

### 4.1 T735 Acceptance Criteria

| ID | Criterion | Status |
|----|-----------|--------|
| AC-1 | `cleo transcript scan` outputs hot/warm/cold counts in LAFS envelope | SHIPPED |
| AC-2 | `cleo transcript prune --dry-run` makes zero filesystem mutations | SHIPPED |
| AC-3 | Budget cap (>5GB) triggers early prune (see `runner.ts` URGENT tier logic) | SHIPPED |
| AC-4 | `ANTHROPIC_API_KEY` absent → 30d-only deletion (no extraction) | SHIPPED |

### 4.2 Cross-Platform Validation

The GC runner calls `checkDiskSpace(cleoDir)` which uses `df` on Unix and `WMIC` on Windows.
All deletion uses `fs.rm({ recursive: true, force: true })` which is cross-platform in Node.js ≥ 14.

---

## 5. Future Work

- `cleo daemon install` — opt-in OS-native scheduler registration (systemd/launchd/schtasks)
- `cleo transcript extract` — full LLM extraction pipeline (T730, blocked on Q4 owner decision)
- Budget cap >5GB triggers immediate extraction (blocked on T730)
- Per-session tombstone verification before deletion (T732 prerequisite)
- `cleo init` prompt to start daemon on first use
