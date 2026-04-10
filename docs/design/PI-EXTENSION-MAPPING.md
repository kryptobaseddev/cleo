# Design-to-Pi Extension API Mapping

> T442 deliverable: maps each design element from the TUI design system to
> what the Pi extension API can actually achieve, with honest gap analysis.

## Pi Extension API Surface

The Pi coding agent (`@mariozechner/pi-coding-agent`) exposes the following
extension capabilities:

| API | Signature | What It Does |
|-----|-----------|--------------|
| `setWidget` | `ctx.ui.setWidget(key, lines[], { placement })` | Renders an array of text lines (supports ANSI escape codes). Placement is `"aboveEditor"` or `"belowEditor"`. |
| `setStatus` | `ctx.ui.setStatus(key, text)` | Sets a single-line entry in the status bar at the bottom of the terminal. |
| `notify` | `ctx.ui.notify(msg, level)` | Shows a toast notification. Levels: `"info"`, `"warning"`, `"error"`. |
| `registerCommand` | `pi.registerCommand(name, { handler })` | Registers a `/name` slash command the user can invoke. |
| `registerTool` | `pi.registerTool(...)` | Registers a tool callable by the LLM during conversation. |
| `sendMessage` | `pi.sendMessage(payload, opts)` | Injects a message into the conversation stream. |
| `on(event)` | `pi.on(event, handler)` | Listens for lifecycle events (`session_start`, `before_agent_start`, `tool_call`, `session_shutdown`). |

### What Pi Does NOT Have

- Custom panels (no sidebar, no split panes, no resizable regions)
- Custom layouts (no CSS grid, no flexbox, no column control)
- Custom fonts or typography (terminal font only)
- Custom CSS or styling beyond ANSI escape codes
- Multi-column rendering within a widget
- Persistent sidebar widgets (widgets are stacked vertically)
- Interactive UI elements (buttons, inputs, dropdowns, modals)
- Click/hover handlers on rendered text
- Animations or transitions
- Image or icon rendering (Unicode glyphs only)

---

## Design Element Mapping

### 1. Color Palette

| Design Token | Hex | Pi Capability | Implementation |
|-------------|-----|---------------|----------------|
| `bg-primary` | `#0a0a0f` | Not applicable | Terminal background is controlled by the user's terminal emulator, not the extension. |
| `bg-secondary` | `#13131f` | Not applicable | Same as above. |
| `bg-tertiary` | `#1a1a2e` | Not applicable | Same as above. |
| `bg-hover` | `#252538` | Not applicable | No hover states in text widgets. |
| `border-subtle` | `#2a2a3e` | ANSI 256-color 236 | Used for box-drawing separator lines via `fg256(text, 236)`. |
| `border-focus` | `#4a4a5e` | ANSI 256-color 240 | Used for active/focus state borders. |
| `accent-primary` | `#a855f7` | ANSI 256-color 135 | `accentPrimary()` — Pi AI branding, headers, banner chrome. |
| `accent-secondary` | `#ec4899` | ANSI 256-color 205 | `accentSecondary()` — secondary emphasis. |
| `accent-success` | `#22c55e` | ANSI 256-color 35 | `accentSuccess()` — active status dots, healthy states. |
| `accent-warning` | `#f59e0b` | ANSI 256-color 214 | `accentWarning()` — paused states, warnings. |
| `accent-error` | `#ef4444` | ANSI 256-color 196 | `accentError()` — error states, failures. |
| `text-primary` | `#f8fafc` | ANSI 256-color 255 | Bold text for headings. |
| `text-secondary` | `#94a3b8` | ANSI 256-color 245 | `textSecondary()` — body text, timestamps. |
| `text-tertiary` | `#64748b` | ANSI 256-color 243 | `textTertiary()` — disabled/placeholder text. |

**Gap**: Background colors cannot be set by extensions. The terminal
background is whatever the user's terminal emulator provides. The design
spec's dark forge aesthetic (`#0a0a0f`) is aspirational for terminals
that already use dark themes, which is the common case for developers.

**Implementation**: All foreground colors are mapped to the closest ANSI
256-color code and exported from `extensions/tui-theme.ts` as named
constants and convenience functions.

### 2. Typography

| Design Element | Spec | Pi Capability | Gap |
|---------------|------|---------------|-----|
| H1 (24px, 700) | Inter font, 24px, bold | `bold()` ANSI escape only | No font control, no size control. Bold is the only emphasis available. |
| H2 (20px, 600) | Inter font, 20px, semi-bold | `bold()` + `accentPrimary()` | Size differentiation via Unicode box-drawing chrome instead of font size. |
| H3 (16px, 600) | Inter font, 16px, semi-bold | `bold()` only | No size differentiation. |
| Body (14px, 400) | Inter font, 14px, regular | Default terminal text | Matches naturally. |
| Mono (13px, 400) | JetBrains Mono | Terminal's monospace font | Terminal is already monospace; this maps naturally. |
| Small (12px, 400) | Inter font, 12px | `textSecondary()` | Size communicated via color dimming rather than actual font size. |
| Tiny (10px, 500) | Inter font, 10px | `textTertiary()` | Size communicated via maximum dimming. |

**Gap**: No font family or size control. Typography hierarchy is
communicated through ANSI bold/color rather than actual font changes.

### 3. Layout Architecture (Three-Panel)

| Design Zone | Spec | Pi Capability | Implementation |
|------------|------|---------------|----------------|
| Left Panel (Archive) | 240px file explorer | Not available | File exploration is handled by Pi's built-in features, not extensions. |
| Center (Forge) | Flexible editor + AI | Pi's built-in editor area | The editor is Pi's core — extensions cannot modify it. |
| Right Panel (Loom Station) | 300px session/recipe panel | Not available | Approximated via `setWidget("cleo-agent-monitor", ..., { placement: "belowEditor" })`. |
| Bottom Panel (Conduit) | 200px terminal | Pi's built-in terminal | The conversation area IS the terminal. |
| Header | 48px navigation bar | Status bar entries | `setStatus()` provides single-line entries at the bottom, not a top header. |

**Gap**: The three-panel layout is fundamentally not achievable through
Pi's extension API. Pi provides a single-column text interface. The design
spec's three-panel vision is aspirational for a future Tauri/web-based
CleoOS shell.

**Implementation**: We approximate the design intent using:
- `setWidget("cleo-banner", ..., { placement: "aboveEditor" })` for the session banner (substitutes for the header)
- `setWidget("cleo-agent-monitor", ..., { placement: "belowEditor" })` for agent activity (substitutes for the right panel)
- `setStatus(key, text)` for persistent status indicators (substitutes for the status bar)
- `/cleo:circle` and `/cleo:agents` commands for on-demand panels (substitutes for always-visible panels)

### 4. The Hearth Zones

| Zone | Design Role | Pi Implementation | Status |
|------|-------------|-------------------|--------|
| The Forge (Center) | Code editor + diff viewer | Pi's built-in editor — no extension control | Not applicable (Pi native) |
| The Impulse Stream (Bottom) | AI terminal streaming | Pi's conversation — no extension control | Not applicable (Pi native) |
| The Loom Station (Right) | Session orchestration | `/cleo:circle` command + agent monitor widget | Partial: on-demand via command |
| The Archive (Left) | File explorer + git | Pi's built-in file tools | Not applicable (Pi native) |
| The Nexus Portal (Global) | Cross-project awareness | Not wired — Nexus API not yet available | Not wired |

### 5. Circle of Ten UI Mapping

| Aspect | Domain | Design Component | Pi Implementation | Data Source |
|--------|--------|-----------------|-------------------|-------------|
| The Smiths | tasks | Task list, epic tree | `/cleo:circle` zone line | `cleo dash --json` → `summary.active` |
| The Weavers | pipeline | Pipeline status bar | `/cleo:circle` zone line | Not wired — no pipeline CLI endpoint |
| The Conductors | orchestrate | Session cards | `/cleo:circle` zone line | `cleo session status --json` → `hasActiveSession` |
| The Artificers | tools | Recipe grid | `/cleo:circle` zone line | CANT bundle → `lastBundleCounts.tools` |
| The Archivists | memory | Memory panel, search | `/cleo:circle` zone line | `cleo dash --json` → `summary` (observations) |
| The Scribes | session | Session notes, handoffs | `/cleo:circle` zone line | `cleo session status --json` → session data |
| The Wardens | check | Validation badges | `/cleo:circle` zone line | `cleo dash --json` → `blockedTasks.count` |
| The Wayfinders | nexus | Project switcher | `/cleo:circle` zone line | Not wired — Nexus deferred |
| The Catchers | sticky | Quick capture button | `/cleo:circle` zone line | Not wired — no sticky API |
| The Keepers | admin | System status, health | `/cleo:circle` zone line | `cleo dash --json` → summary totals |

### 6. Components

| Design Component | Pi Mapping | Notes |
|-----------------|------------|-------|
| Session Card | Text lines in widget | Box-drawing characters approximate the card border. No interactivity. |
| Recipe Grid | Not implementable | Requires 2D grid layout and click handlers. Replaced by tool count in status bar. |
| Progress Bar | Unicode block characters | `\u2588` (full block) and `\u2591` (light shade) approximate progress fills. |
| Git Status Badge | Status bar entry | `setStatus("cleo-tier", ...)` shows the current tier. |
| AI Message Bubbles | Not applicable | Pi's conversation rendering handles message display natively. |
| Diff Viewer | Not applicable | Pi's built-in diff tool handles this natively. |
| Resource Monitor | Not implementable | Requires real-time updating bars. Could be added to `/cleo:circle` as static snapshot. |
| Notification Toast | `ctx.ui.notify()` | Direct mapping. Supports info/warning/error levels. |
| Buttons | Not implementable | No interactive elements in text widgets. Commands substitute for button clicks. |
| Input Fields | Not implementable | Pi's conversation input is the only text input. |
| Modals | Not implementable | No overlay/modal support in the extension API. |

### 7. Animations

| Design Animation | Pi Capability | Status |
|-----------------|---------------|--------|
| Panel slide (200ms) | Not available | No animation support. |
| Modal open/close | Not available | No modals. |
| Tab switch (150ms) | Not available | No tabs. |
| Button press (100ms) | Not available | No buttons. |
| Toast enter (200ms) | Handled by Pi | `notify()` may have its own animation. |
| AI typing (30ms/char) | Handled by Pi | Pi's streaming renderer handles this. |
| Shimmer/pulse | Not available | Static text only. |

---

## Summary: What Is Achievable

### Fully Achievable
- Color palette mapped to ANSI 256-color (foreground only)
- Status bar entries with domain indicators
- Session banner with box-drawing forge aesthetic
- Slash commands for on-demand status panels
- Toast notifications for system events
- Agent activity tracking in below-editor widget
- Circle of Ten status with live CLI data

### Partially Achievable
- Typography hierarchy (bold/color only, no font/size control)
- Component cards (text approximation, no interactivity)
- Progress indicators (Unicode blocks, no animation)
- Circle of Ten zones (data available for 6/10, 4 not wired)

### Not Achievable (Pi API Limitation)
- Three-panel layout
- Custom backgrounds
- Interactive UI elements (buttons, inputs, dropdowns)
- Recipe grid with click-to-run
- Resizable panels
- Animations and transitions
- Custom fonts or typography
- Persistent sidebar widgets
- Multi-column rendering within widgets

### Design Gap Resolution

The design documents describe a full IDE-class interface (Tauri + React/Vue
+ Monaco + xterm.js). The Pi extension API provides a text-mode widget
system within a terminal-based coding agent. The gap is fundamental and
expected — the design docs serve as the north-star vision for a future
CleoOS desktop application, while the Pi extensions implement the
maximum-fidelity TUI approximation within the current constraints.

The shared `tui-theme.ts` module ensures that when the full IDE surface is
eventually built, the color tokens and naming conventions will carry over
directly from the TUI layer.
