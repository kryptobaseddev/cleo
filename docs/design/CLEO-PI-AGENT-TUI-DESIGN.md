# CLEO - PI_AGENT TUI Design Document
## Overview
This document outlines the comprehensive **Pi Code Agent harness** design philosophy and implementation architecture. It serves as the canonical reference for integrating the Pi coding agent into CleoOS as the first-class primary harness, defining all capabilities, hooks, and extension points.
### Core Design Tenets
1. **Single Source of Truth**: The Pi harness (`pi.ts`) is the canonical path for all Pi-related operations
2. **Three-Tier Scope**: Extensions/instructions operate at project → user → global precedence
3. **Provider-Agnostic**: Core business logic remains portable via `@cleocode/core`
4. **Hook-Driven**: Uses standard CAAMP provider lifecycle hooks
5. **Extension First**: All capabilities exposed through the extension system
---
## Visual Design System
### Color Palette
| Token | Value | Usage |
|-------|-------|-------|
| `bg-primary` | `#0a0a0f` | Main background, terminal areas |
| `bg-secondary` | `#13131f` | Panels, cards, elevated surfaces |
| `bg-tertiary` | `#1a1a2e` | Input fields, subtle highlights |
| `bg-hover` | `#252538` | Hover states |
| `border-subtle` | `#2a2a3e` | Dividers, borders |
| `border-focus` | `#4a4a5e` | Focus rings |
| `accent-primary` | `#a855f7` | Primary purple accent (Pi AI) |
| `accent-secondary` | `#ec4899` | Secondary pink accent |
| `accent-success` | `#22c55e` | Success states |
| `accent-warning` | `#f59e0b` | Warning states |
| `accent-error` | `#ef4444` | Error states |
| `text-primary` | `#f8fafc` | Primary text |
| `text-secondary` | `#94a3b8` | Secondary/muted text |
| `text-tertiary` | `#64748b` | Tertiary/disabled text |
### Typography
| Element | Font | Size | Weight | Line Height |
|---------|------|------|--------|-------------|
| H1 | Inter | 24px | 700 | 1.2 |
| H2 | Inter | 20px | 600 | 1.3 |
| H3 | Inter | 16px | 600 | 1.4 |
| Body | Inter | 14px | 400 | 1.5 |
| Mono | JetBrains Mono | 13px | 400 | 1.6 |
| Small | Inter | 12px | 400 | 1.4 |
| Tiny | Inter | 10px | 500 | 1.3 |
### Spacing System
| Token | Value | Usage |
|-------|-------|-------|
| `space-xs` | 4px | Tight spacing |
| `space-sm` | 8px | Default spacing |
| `space-md` | 12px | Section padding |
| `space-lg` | 16px | Panel padding |
| `space-xl` | 24px | Major sections |
| `space-2xl` | 32px | Layout gaps |
### Border Radius
| Token | Value | Usage |
|-------|-------|-------|
| `radius-sm` | 4px | Buttons, tags |
| `radius-md` | 6px | Cards, inputs |
| `radius-lg` | 8px | Panels, modals |
| `radius-xl` | 12px | Large containers |
### Shadows
```css
/* Card elevation */
shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.3);
/* Panel elevation */
shadow-md: 0 4px 6px rgba(0, 0, 0, 0.4);
/* Modal elevation */
shadow-lg: 0 10px 25px rgba(0, 0, 0, 0.5);
/* Glow effects */
glow-accent: 0 0 20px rgba(168, 85, 247, 0.3);
glow-success: 0 0 20px rgba(34, 197, 94, 0.3);
glow-error: 0 0 20px rgba(239, 68, 68, 0.3);
```
---
## Layout Architecture
### Three-Panel Layout
```
┌─────────────────────────────────────────────────────────────────────────────┐
│  [Logo] CleoOS    Editor  Terminal  Live Preview  Logs          [User]   [?]│
├──────────────┬──────────────────────────────────────────────┬───────────────┤
│              │                                              │               │
│   LEFT       │             CENTER WORKSPACE                 │    RIGHT      │
│   PANEL      │                                              │    PANEL      │
│              │                                              │               │
│  (240px)     │           (flex: 1, min: 600px)              │   (300px)     │
│              │                                              │               │
├──────────────┼──────────────────────────────────────────────┼───────────────┤
│              │  BOTTOM TERMINAL / AI CONSOLE                │               │
│              │  (collapsible, default: 200px)                │               │
└──────────────┴──────────────────────────────────────────────┴───────────────┘
```
### Panel Specifications
#### Left Panel (240px fixed)
- File Explorer tree view
- Git changes indicator
- Workspace actions toolbar
- Branch/Environment selector (bottom)
#### Center Workspace (flexible)
- Tabbed interface for multiple views
- Editor (Monaco/CodeMirror)
- Terminal (xterm.js)
- Live Preview (iframe with dev tools)
- Diff viewer
#### Right Panel (300px fixed)
- Session Orchestrator
- Recipe Grid
- Resource metrics
- Quick actions
#### Bottom Terminal (200px default, collapsible)
- AI Terminal (Pi Code TUI)
- System console
- Logs viewer
- Command palette
---
## Component Library
### 1. Navigation Components
#### Top Navigation Bar
```
┌─────────────────────────────────────────────────────────────────────────────┐
│ [C Logo] CleoOS  │  Editor  │  Terminal  │  Live Preview  │  Logs  │  [🔍]  │
└─────────────────────────────────────────────────────────────────────────────┘
Height: 48px
Background: bg-primary
Border-bottom: 1px solid border-subtle
```
**Specifications:**
- Logo: 32px × 32px with gradient accent
- Nav items: 14px font, 24px horizontal padding
- Active state: accent-primary underline (2px)
- Hover: text-primary with subtle bg-hover
#### Sidebar Toggle
- Icon-only button (24px)
- Collapse/expand with animation (200ms ease)
- Tooltip on hover
### 2. Explorer Components
#### File Tree
```
📁 src
  📁 components
    📄 Button.tsx        [M]      ← Modified indicator
    📄 Card.tsx
  📄 index.ts            [U]      ← Untracked
  📄 utils.ts            [ ]      ← Clean
```
**Specifications:**
- Indent: 16px per level
- File icon: 16px, color-coded by extension
- Git status: 6px dot (green=modified, yellow=untracked, red=deleted)
- Hover: bg-hover
- Selected: bg-tertiary + accent-primary border-left (2px)
#### Git Status Badge
```
┌────────────────────────┐
│  🌿 main  ▼  │  🟢 12  │
└────────────────────────┘
Background: bg-tertiary
Border-radius: radius-md
Font: 12px mono
```
### 3. Editor Components
#### Code Editor Tab
```
┌───────────────────────────────────────────────────────────────┐
│ action.config.ts  [×]  │  [×]  │  +                          │
│         ◆                                                     │
└───────────────────────────────────────────────────────────────┘
Active tab: bg-secondary
Inactive: bg-primary
Modified indicator: ◆ (white dot)
Close button: appears on hover
```
#### Code Editor Surface
```
Background: bg-primary
Font: JetBrains Mono 13px
Line height: 1.6
Padding: 16px
```
### 4. Terminal Components
#### AI Terminal Header
```
┌───────────────────────────────────────────────────────────────┐
│  CLEO AI TERMINAL              ● IDLE  │  ⬇  │  ×            │
└───────────────────────────────────────────────────────────────┘
Background: bg-secondary
Status dot: 8px (●=idle, 🟡=thinking, 🟢=streaming, 🔴=error)
```
#### AI Message Bubbles
**User Message:**
```
┌───────────────────────────────────────────────────────────────┐
│ > Fix the authentication bug in login.tsx                     │
│                                      [timestamp]              │
└───────────────────────────────────────────────────────────────┘
Background: bg-tertiary
Border-left: 3px solid accent-secondary
Font: 14px
```
**AI Response (Streaming):**
```
┌───────────────────────────────────────────────────────────────┐
│ [⚡] Analyzing file structure...                               │
│                                                                │
│ I'll fix the authentication bug by updating the token         │
│ validation logic. Here's the diff:                            │
│                                                                │
│ [Code block with syntax highlighting]                         │
│                                                                │
│ ┌───────────────────────────────────────────────────────────┐│
│ │ [Apply Changes]  [View Diff]  [Dismiss]                   ││
│ └───────────────────────────────────────────────────────────┘│
└───────────────────────────────────────────────────────────────┘
Background: bg-secondary
Border-left: 3px solid accent-primary
Font: 14px
```
**AI Thought Process:**
```
┌───────────────────────────────────────────────────────────────┐
│ 💭 Thought Process                                             │
│ 1. Located auth logic in src/auth/token.ts                    │
│ 2. Identified missing expiration check                        │
│ 3. Will add isTokenValid() helper function                    │
└───────────────────────────────────────────────────────────────┘
Background: rgba(168, 85, 247, 0.1)
Font: 12px italic
Color: accent-primary
```
### 5. Orchestration Components
#### Session Card
```
┌───────────────────────────────────────────────────────────────┐
│ ● draftframe-editor                     [● ACTIVE]            │
│   14m  │  💾 1.4GB                                                   │
│                                                               │
│ [⏹ Stop]  [🔄 Restart]  [🗑 Delete]                          │
└───────────────────────────────────────────────────────────────┘
Background: bg-secondary
Border: 1px solid border-subtle
Border-radius: radius-md
Hover: border-focus
```
**Specifications:**
- Status colors: active=green, paused=yellow, failed=red, completed=gray
- Progress bar: thin line (2px) below status
- Actions: icon buttons with tooltips
#### Recipe Grid
```
┌───────────────────────────────────────────────────────────────┐
│ ⚡ Nuxi Hydrate      │  🛠 Drizzle Mig                       │
│ ⚡ Jest Clean         │  📜 Shell Script                      │
└───────────────────────────────────────────────────────────────┘
Card size: 120px × 80px
Background: bg-tertiary
Hover: bg-hover + shadow-sm
Border-radius: radius-md
Icon: 24px, accent color
Label: 12px, centered
```
### 6. Status & Progress Components
#### Progress Bar
```
┌───────────────────────────────────────────────────────────────┐
│ Analyzing Theme Tokens                          85%           │
│ ████████████████████████████████░░░░░░░░░░░░░░░░░░░           │
└───────────────────────────────────────────────────────────────┘
Height: 4px (thin) or 8px (standard)
Background: bg-tertiary
Fill: gradient from accent-primary to accent-secondary
Animation: shimmer effect during progress
```
#### Resource Monitor
```
┌───────────────────────────────────────────────────────────────┐
│ Synthetic Intelligence                        ████████░░ 84%  │
│ Cluster Throughput                            ██████░░░░ 32.4GB/s│
└───────────────────────────────────────────────────────────────┘
Background: transparent
Label: 12px text-secondary
Value: 12px mono, text-primary
Bar: 4px height, accent-primary fill
```
### 7. Interactive Components
#### Buttons
**Primary Button:**
```
┌─────────────────────────────────────┐
│      Start Session                  │
└─────────────────────────────────────┘
Background: gradient accent-primary → accent-secondary
Color: white
Padding: 12px 24px
Border-radius: radius-md
Hover: brightness(1.1), glow-accent
Active: brightness(0.95)
```
**Secondary Button:**
```
┌─────────────────────────────────────┐
│      Open Terminal                  │
└─────────────────────────────────────┘
Background: bg-tertiary
Color: text-primary
Border: 1px solid border-subtle
Hover: bg-hover
```
**Ghost Button:**
```
Background: transparent
Color: text-secondary
Hover: bg-hover, text-primary
```
**Icon Button:**
```
Size: 32px × 32px
Background: transparent
Border-radius: radius-sm
Hover: bg-hover
```
#### Input Fields
**Text Input:**
```
┌───────────────────────────────────────────────────────────────┐
│ Search workspace...                                           │
└───────────────────────────────────────────────────────────────┘
Background: bg-tertiary
Border: 1px solid border-subtle
Border-radius: radius-md
Padding: 8px 12px
Focus: border-accent-primary, glow-accent
Placeholder: text-tertiary
```
**Command Input (Terminal):**
```
> │                                                             │
Background: transparent
Font: JetBrains Mono 13px
Caret: accent-primary, block style (█)
Prompt: > (accent-secondary)
```
#### Dropdown
```
┌───────────────────────────────────────────────────────────────┐
│ 🌿 main                              ▼                        │
└───────────────────────────────────────────────────────────────┘
Background: bg-tertiary
Border-radius: radius-md
Hover: bg-hover
Open state: shadow-lg
```
---
## State Management
### Visual States
| State | Visual Treatment |
|-------|------------------|
| Default | Base styles |
| Hover | bg-hover, subtle brightness increase |
| Focus | border-accent-primary, glow effect |
| Active | brightness(0.95), pressed appearance |
| Disabled | opacity(0.4), cursor: not-allowed |
| Loading | Spinner overlay, reduced opacity |
| Error | border-accent-error, glow-error |
| Success | border-accent-success, glow-success |
### Animations
| Animation | Duration | Easing | Usage |
|-----------|----------|--------|-------|
| Fade in | 150ms | ease-out | Modal, tooltip |
| Slide in | 200ms | cubic-bezier(0.4, 0, 0.2, 1) | Panel collapse |
| Scale | 100ms | ease-out | Button press |
| Shimmer | 1500ms | linear | Loading bars |
| Pulse | 2000ms | ease-in-out | Status indicators |
| Typing | 30ms/char | linear | AI streaming |
---
## Screen Specifications
### 1. Empty State / Welcome
```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              [Logo Large]                                   │
│                                                                            │
│                        Your workspace is ready                             │
│                                                                            │
│         The environment for {projectName} has been provisioned.            │
│                  Connect your agent to begin orchestration.                │
│                                                                            │
│              [Start Session]        [Open Terminal]                        │
│                                                                            │
└─────────────────────────────────────────────────────────────────────────────┘
Logo: 96px with animated gradient
Buttons: Primary + Secondary, centered
Background: subtle radial gradient from center
```
### 2. Active Workspace (Editor + AI)
```
┌─────────────────────────────────────────────────────────────────────────────┐
│ Left Panel │        Editor + AI Terminal Split          │  Right Panel   │
│            │                                            │                │
│  Explorer  │  ┌────────────────┐  ┌─────────────────┐  │  Orchestration │
│            │  │                │  │   Pi Code AI    │  │                │
│  [Files]   │  │   Code Editor  │  │                 │  │  [Sessions]    │
│            │  │                │  │  [Streaming]    │  │  [Recipes]     │
│  [Git]     │  │   [Syntax      │  │                 │  │  [Metrics]     │
│            │  │    Highlighted]│  │  [Suggestions]  │  │                │
│  [Search]  │  │                │  │                 │  │                │
│            │  └────────────────┘  └─────────────────┘  │                │
└────────────┴────────────────────────────────────────────┴────────────────┘
```
**Layout specs:**
- Split ratio: 60% editor / 40% AI terminal
- Resizable divider (8px hit area, 1px visible)
- Sync scroll option for diff view
### 3. Terminal-Full Mode
```
┌─────────────────────────────────────────────────────────────────────────────┐
│ Left Panel │              AI Terminal (Full Width)          │  Right Panel │
│            │                                               │              │
│  Explorer  │                                               │  Orchestration│
│            │   ┌─────────────────────────────────────────┐ │              │
│            │   │  cleo list-active-sessions              │ │              │
│            │   │                                         │ │              │
│            │   │  Session ID        Status    Duration   │ │              │
│            │   │  frontend-refactor Running   02:45:12   │ │              │
│            │   │  api-integration   Paused    00:12:05   │ │              │
│            │   │                                         │ │              │
│            │   │  [⚙️] Cleo AI  SYNTHESIZING             │ │              │
│            │   │                                         │ │              │
│            │   │  I've analyzed the frontend-refactor    │ │              │
│            │   │  session. The current bottlenecks...    │ │              │
│            │   │                                         │ │              │
│            │   │  [Execute Recipe: Tree-Shake] [View Details]│             │
│            │   │                                         │ │              │
│            │   └─────────────────────────────────────────┘ │              │
│            │                                               │              │
│            │   > │                                         │              │
│            │                                               │              │
└────────────┴───────────────────────────────────────────────┴──────────────┘
```
### 4. Live Preview Mode
```
┌─────────────────────────────────────────────────────────────────────────────┐
│ Left Panel │         Live Preview + DevTools Split          │ Right Panel  │
│            │                                               │              │
│            │  ┌─────────────────────────────────────────┐  │              │
│            │  │  Browser Viewport          [60 FPS]     │  │              │
│            │  │  ┌─────────────────────────────────────┐│  │              │
│            │  │  │                                     ││  │              │
│            │  │  │    [Rendered Web App]               ││  │              │
│            │  │  │    ┌─────┐ ┌─────┐ ┌─────┐         ││  │              │
│            │  │  │    │     │ │     │ │     │         ││  │              │
│            │  │  │    └─────┘ └─────┘ └─────┘         ││  │              │
│            │  │  │                                     ││  │              │
│            │  │  │    Inventory Management             ││  │              │
│            │  │  │                                     ││  │              │
│            │  │  └─────────────────────────────────────┘│  │              │
│            │  └─────────────────────────────────────────┘  │              │
│            │                                               │              │
│            │  ┌─────────────────────────────────────────┐  │              │
│            │  │  DOM TREE │ Elements │ Styles │ ...     │  │              │
│            │  │  <html>                                 │  │              │
│            │  │    <body class="bg-white">              │  │              │
│            │  │      <header>...</header>               │  │              │
│            │  │      <main>                             │  │              │
│            │  │        <div class="grid grid-cols-3">   │  │              │
│            │  │          [highlighted element]          │  │              │
│            │  └─────────────────────────────────────────┘  │              │
└────────────┴───────────────────────────────────────────────┴──────────────┘
```
### 5. Diff View Mode
```
┌─────────────────────────────────────────────────────────────────────────────┐
│ Left Panel │  action.config.ts (Working Tree)    -2 lines  +3 lines  [×]  │
│            │  ─────────────────────────────────────────────────────────────│
│            │  │ ORIGINAL          │ MODIFIED          │ THOUGHT           │
│            │  ─────────────────────────────────────────────────────────────│
│            │  │                   │                   │ PLAN              │
│            │  │ import {          │ import {          │ 1 Parse config    │
│            │  │   defineConfig    │   defineConfig    │ 2 Map orchestration│
│            │  │ } from '@cleo/    │ } from '@cleo/    │ 3 Inject auto-heal│
│            │  │   core';          │   core';          │                   │
│            │  │                   │                   │ ──────────────────│
│            │  │ export default    │ export default    │ CONFIDENCE        │
│            │  │ defineConfig({    │ defineConfig({    │ Logic    ████████░│
│            │  │   version:        │   version:        │          98%      │
│            │  │     '2.4.0',      │     '2.4.0',      │ Security ██████░░░│
│            │  │   features: {     │   capabilities: { │          82%      │
│            │  │ -   orchestration:│ +   auto_heal:    │                   │
│            │  │ -     true,       │ +   true,         │                   │
│            │  │     ai_streaming: │     ai_streaming: │                   │
│            │  │       true,       │       true,       │                   │
│            │  │   },              │   },              │                   │
│            │  └───────────────────┴───────────────────┴───────────────────┘│
└────────────┴───────────────────────────────────────────────────────────────┘
```
---
## Responsive Behavior
### Breakpoints
| Breakpoint | Width | Layout Changes |
|------------|-------|----------------|
| Desktop XL | ≥1600px | Full 3-panel, side-by-side editor/AI |
| Desktop | 1200-1599px | Full 3-panel, stacked editor/AI |
| Laptop | 992-1199px | Collapsible right panel |
| Tablet | 768-991px | Left panel as overlay, single column |
| Mobile | <768px | Bottom sheet navigation, single view |
### Panel Collapse States
| State | Left | Right | Bottom |
|-------|------|-------|--------|
| Focus Code | Collapsed | Collapsed | Visible |
| Focus AI | Collapsed | Visible | Expanded |
| Focus Preview | Collapsed | Visible | Collapsed |
| Overview | Visible | Visible | Visible |
---
## The Hearth: Terminal Workshop Surface
### Purpose
The Hearth is the terminal-facing workshop surface where the Circle of Ten aspects manifest as interactive UI elements, sessions are orchestrated, and the Pi Code Agent engages with the user.
### Key Zones
1. **The Forge** (Center): Where code is written and modified
2. **The Impulse Stream** (Bottom): AI terminal with real-time streaming
3. **The Loom Station** (Right): Session orchestration and recipe execution
4. **The Archive** (Left): File tree with git integration
5. **The Nexus Portal** (Global): Cross-project awareness
### Circle of Ten UI Mapping
| Aspect | Domain | UI Element | Function |
|--------|--------|------------|----------|
| The Smiths | tasks | Task list, epic tree | Forge threads |
| The Weavers | pipeline | Pipeline status bar | Mount looms |
| The Conductors | orchestrate | Session cards | Assign motion |
| The Artificers | tools | Recipe grid | Supply cogs |
| The Archivists | memory | Memory panel, search | Tend observations |
| The Scribes | session | Session notes, handoffs | Hold context |
| The Wardens | check | Validation badges | Judge quality |
| The Wayfinders | nexus | Project switcher | Govern star road |
| The Catchers | sticky | Quick capture button | Carry captures |
| The Keepers | admin | System status, health | Maintain continuity |
---
## Implementation Notes
### Tech Stack
- **Framework**: Tauri (Rust + Web frontend)
- **Frontend**: React/Vue/Svelte with TypeScript
- **Terminal**: xterm.js for terminal emulation
- **Editor**: Monaco Editor or CodeMirror 6
- **Styling**: Tailwind CSS or CSS-in-JS
- **State**: Zustand or Pinia
### Pi Harness Integration
The Pi harness exposes these capabilities to the UI:
1. **Session Management**: List, create, monitor, terminate Pi sessions
2. **Extension Loading**: Install/remove extensions at project/user/global scope
3. **Instruction Injection**: Add/remove system instructions
4. **Theme Support**: Install/remove custom themes
5. **Prompt Management**: Install/remove custom prompts
6. **Model Configuration**: Read/write models.json and settings.json
7. **CANT Profile Management**: Install/remove Code Agent Navigation Tool profiles
### Extension Points
The UI provides extension points for:
- Custom panels (right sidebar)
- Toolbar actions
- Context menu items
- Status bar widgets
- Recipe cards
- Theme contributions
---
## File Structure
```
src/
├── components/
│   ├── ui/                 # Base UI components
│   │   ├── Button.tsx
│   │   ├── Input.tsx
│   │   ├── Card.tsx
│   │   └── ...
│   ├── navigation/
│   │   ├── TopNav.tsx
│   │   ├── Sidebar.tsx
│   │   └── StatusBar.tsx
│   ├── editor/
│   │   ├── CodeEditor.tsx
│   │   ├── DiffViewer.tsx
│   │   └── FileTabs.tsx
│   ├── terminal/
│   │   ├── AITerminal.tsx
│   │   ├── MessageBubble.tsx
│   │   └── CommandInput.tsx
│   ├── orchestration/
│   │   ├── SessionPanel.tsx
│   │   ├── SessionCard.tsx
│   │   └── RecipeGrid.tsx
│   └── preview/
│       ├── LivePreview.tsx
│       └── DevTools.tsx
├── hooks/
│   ├── usePiHarness.ts
│   ├── useSessions.ts
│   └── useTheme.ts
├── stores/
│   ├── uiStore.ts
│   ├── sessionStore.ts
│   └── editorStore.ts
├── styles/
│   ├── tokens.css          # CSS custom properties
│   └── animations.css
└── lib/
    ├── pi-harness.ts       # Pi harness client
    └── theme.ts            # Theme utilities
```
---
## Accessibility
### Requirements
- Full keyboard navigation support
- ARIA labels on all interactive elements
- Focus indicators visible at all times
- Color contrast ≥ 4.5:1 for text
- Screen reader announcements for status changes
- Reduced motion support via `prefers-reduced-motion`
### Keyboard Shortcuts
| Shortcut | Action |
|----------|--------|
| `Cmd/Ctrl + B` | Toggle left panel |
| `Cmd/Ctrl + J` | Toggle bottom terminal |
| `Cmd/Ctrl + Shift + E` | Focus explorer |
| `Cmd/Ctrl + Shift + F` | Focus search |
| `Cmd/Ctrl + Shift + G` | Focus git panel |
| `Cmd/Ctrl + P` | Quick open file |
| `Cmd/Ctrl + Shift + P` | Command palette |
| `Cmd/Ctrl + Shift + M` | Focus AI terminal |
| `Cmd/Ctrl + Enter` | Send AI message |
| `Escape` | Close panel/modal |
---
## Summary
This design system provides a complete foundation for the CleoOS Pi Code Agent harness interface. It emphasizes:
1. **Density**: High information density without clutter
2. **Speed**: Fast interactions with minimal latency
3. **Context**: AI context always visible alongside code
4. **Extensibility**: Plugin architecture for custom capabilities
5. **Lore**: Circle of Ten aspects manifested in UI patterns
The Hearth becomes the workshop where AI agents and humans collaborate, with the Pi harness as the primary conduit for agent capabilities.
