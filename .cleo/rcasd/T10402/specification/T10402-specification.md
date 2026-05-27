---
epic: T10402
stage: specification
task: T10402
related:
  - type: saga
    id: T10402
  - type: research
    path: ../research/T10402-research.md
  - type: consensus
    path: ../consensus/T10402-consensus.md
  - type: adr
    path: ../architecture/T10402-architecture-decision.md
created: 2026-05-27
updated: 2026-05-27
---

# Specification (T10402) — SG-COCKPIT-HARNESS

## Functional Spec

### F1: Daemon Connection
- Connect to daemon over HTTPS control plane (via T10409 gateway) and ZeroMQ data plane
- Unix socket fallback at `~/.local/share/cleo/daemon.sock` for same-machine usage
- Heartbeat monitoring: PUB/SUB pings at 1Hz; miss 3 consecutive → overlay "Connection Lost" with reconnect countdown
- Auto-reconnect with exponential backoff (1s, 2s, 4s, 8s, max 30s)

### F2: HUD Panel (Left Sidebar)
- Display: daemon PID, uptime (HH:MM:SS), memory usage (MB), active worker count, queue depth
- Connection status indicator: green dot (connected), yellow (degraded), red (lost)
- Living Brain stubs (Wave 2): placeholder panels for Braille Canvas and Semantic Ledger
- Dream State indicator: palette shifts from blue to purple when daemon reports consolidation mode

### F3: Pipeline Panel (Right Sidebar)
- Collapsible tree: Saga → Epic → Task → Subtask hierarchy
- Color-coded LOOM phase tags: RCASD phases (blue), IVTR phases (green)
- Task status: pending (gray), claimed (yellow), running (cyan/animating), completed (green), failed (red), blocked (orange)
- Keyboard: Enter to expand/collapse, j/k to navigate, Space to select, / to filter
- Mouse: click to expand/collapse/select

### F4: Orchestrator Panel (Center Top)
- Scrolling chat feed: Prime Orchestrator messages (left-aligned, Cleo identity)
- Conduit agent-debate feed: inter-agent messages (right-aligned, agent-identity tags)
- Timestamps on each message (HH:MM:SS)
- Agent identity: colored badge per agent (Lead Agents, Ephemeral Workers)
- Message input: `>` prompt at bottom; Enter to send, supports keyboard-only workflow
- Scrollback: PageUp/PageDown, Home/End, or mouse scroll

### F5: PTY Isolation Zone (Center Bottom)
- Dynamic grid: 1×1 default, expands to 2×2, 3×2, etc. as workers spawn
- Each pane shows: worker ID badge, task ID, iteration counter, status indicator
- Real-time stdout/stderr streaming from ZeroMQ PUB/SUB
- Colored output: preserves ANSI escape codes from worker stdout
- Scrollback per pane: Shift+PageUp/PageDown
- Keyboard controls:
  - Ctrl+Tab: cycle focus between panes
  - Ctrl+W: close focused pane (sends SIGTERM to worker via daemon IPC)
  - Ctrl+Shift+Arrow: resize focused pane
  - Ctrl+[ / Ctrl+]: cycle between PTY panes
- Crash-safe: worker process crash/cancellation collapses its pane without affecting TUI

### F6: Global Keybindings
- `q` or `Ctrl+C`: quit Cockpit (graceful disconnect from daemon)
- `1`/`2`/`3`/`4`: focus HUD / Pipeline / Orchestrator / Isolation panels
- `F5`: force refresh (re-query daemon status)
- `?`: show help overlay with all keybindings
- `Ctrl+L`: clear orchestrator chat scrollback
- `r`: request daemon restart (confirm dialog)
- `s`: start daemon dispatch loop
- `x`: stop daemon dispatch loop

## Non-Functional Spec

### N1: Performance
- TUI render at 60fps during normal operation; minimum 30fps under PTY streaming load
- ZeroMQ SUB socket handles 10+ concurrent worker PTY streams without frame drops
- Startup time <500ms from binary launch to rendered TUI
- Memory usage <200MB with 10 active PTY sessions

### N2: Reliability
- Cockpit process crash must NOT affect daemon or running workers
- Daemon process crash must NOT crash Cockpit (Connection Lost overlay, reconnect)
- PTY pane crash isolated to that pane only
- All IPC errors handled gracefully with user-visible status

### N3: Compatibility
- Terminal: xterm-256color minimum; TrueColor (24-bit) preferred
- Minimum terminal size: 120×40 characters
- OS: Linux primary (tokio + crossterm), macOS compatible, Windows stretch goal
- Unicode: full UTF-8 support including braille characters (U+2800-U+28FF)

### N4: Security
- No credential storage in Cockpit (all auth via T10409 gateway JWT Proxy-Authorization)
- Worker PTY isolation maintained by daemon; Cockpit is a read-only stream consumer
- No shell execution in Cockpit process
- All daemon commands validated against LAFS envelope schema before sending
