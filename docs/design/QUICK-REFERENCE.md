# CleoOS UI/UX - Quick Reference Guide
## Design System Overview
### Visual Identity
**Theme**: Dark forge aesthetic with purple AI accents
**Density**: High information density, professional developer tooling
**Metaphor**: Workshop surface (The Hearth) where Circle of Ten aspects collaborate
---
## Color Tokens
```
Backgrounds:
  bg-primary:    #0a0a0f  (main background)
  bg-secondary:  #13131f  (panels)
  bg-tertiary:   #1a1a2e  (inputs, cards)
  bg-hover:      #252538  (hover states)
Accents:
  accent-primary:    #a855f7  (purple - Pi AI)
  accent-secondary:  #ec4899  (pink)
  accent-success:    #22c55e  (green)
  accent-warning:    #f59e0b  (amber)
  accent-error:      #ef4444  (red)
Text:
  text-primary:    #f8fafc  (headings)
  text-secondary:  #94a3b8  (body)
  text-tertiary:   #64748b  (muted)
Borders:
  border-subtle:  #2a2a3e
  border-focus:   #4a4a5e
```
---
## Layout Structure
```
┌─────────────────────────────────────────────────────────────────┐
│  HEADER (48px)                                                  │
│  [Logo] Nav Items                    Search  User  Help        │
├──────────┬──────────────────────────────────┬───────────────────┤
│          │                                  │                   │
│  LEFT    │         CENTER WORKSPACE         │     RIGHT         │
│  PANEL   │                                  │     PANEL         │
│  240px   │                                  │     300px         │
│          │  ┌──────────────┬──────────────┐ │                   │
│  [The    │  │              │              │ │   [The Loom       │
│   Archive]│  │   The Forge  │ The Impulse  │ │    Station]       │
│          │  │              │   Stream     │ │                   │
│  Explorer│  │  Code Editor │  AI Terminal │ │   Sessions        │
│  Git     │  │  Diff Viewer │  Streaming   │ │   Recipes         │
│  Search  │  │  Preview     │  Chat UI     │ │   Metrics         │
│          │  │              │              │ │                   │
│          │  └──────────────┴──────────────┘ │                   │
│          │                                  │                   │
├──────────┴──────────────────────────────────┴───────────────────┤
│  BOTTOM PANEL (200px) - The Conduit                             │
│  AI Terminal / System Console / Logs                           │
└─────────────────────────────────────────────────────────────────┘
```
---
## Circle of Ten UI Mapping
| Aspect | Domain | Workshop Role | UI Location | Key Component |
|--------|--------|---------------|-------------|---------------|
| **The Smiths** | tasks | Forge threads | Left + Center | File tree, Code editor |
| **The Weavers** | pipeline | Mount looms | Right panel | Pipeline status bar |
| **The Conductors** | orchestrate | Assign motion | Right panel | Session cards |
| **The Artificers** | tools | Supply cogs | Right panel | Recipe grid |
| **The Archivists** | memory | Tend archive | Left panel | Memory search |
| **The Scribes** | session | Hold context | Bottom panel | AI terminal |
| **The Wardens** | check | Judge quality | Center panel | Diff viewer, badges |
| **The Wayfinders** | nexus | Star road | Left panel | Project switcher |
| **The Catchers** | sticky | Quick capture | Bottom panel | Sticky notes |
| **The Keepers** | admin | Maintain health | Right panel | System status |
---
## Key Components
### 1. Session Card
```
┌───────────────────────────────────────────────────────────────┐
│ ● session-name                          [● STATUS]            │
│   Duration │ Memory │ Progress                                │
│                                                               │
│ [⏹ Stop] [🔄 Restart] [🗑 Delete]                           │
└───────────────────────────────────────────────────────────────┘
Status Colors:
  ● Active   = Green (#22c55e)
  ● Paused   = Yellow (#f59e0b)
  ● Failed   = Red (#ef4444)
  ● Complete = Gray (#64748b)
```
### 2. Recipe Grid Item
```
┌─────────────────────┐
│        Icon         │  ← 24px, accent color
│                     │
│    RECIPE NAME      │  ← 10px uppercase
│                     │
│ [Run]  [Configure]  │
└─────────────────────┘
Size: 100px × 80px
Background: bg-tertiary
Hover: border accent-primary
```
### 3. AI Message Bubble
```
User Message:
┌───────────────────────────────────────────────────────────────┐
│ > User prompt text here...                    [timestamp]     │
└───────────────────────────────────────────────────────────────┘
Background: bg-tertiary
Border-left: 3px accent-secondary
AI Response:
┌───────────────────────────────────────────────────────────────┐
│ [⚡] AI response streaming here...                            │
│                                                               │
│ 💭 Thought: Showing reasoning process...                      │
│                                                               │
│ [Code block]                                                  │
│                                                               │
│ [Apply] [View Diff] [Dismiss]                                 │
└───────────────────────────────────────────────────────────────┘
Background: bg-secondary
Border-left: 3px accent-primary
```
### 4. Git Status Indicators
```
File Tree:
📄 filename.ts    [M]  ← Modified (yellow)
📄 filename.ts    [U]  ← Untracked (green)
📄 filename.ts    [D]  ← Deleted (red)
📄 filename.ts    [●]  ← Staged (blue)
6px dot indicator
```
### 5. Diff Viewer
```
┌──────────────────────────┬──────────────────────────┬──────────────────┐
│ ORIGINAL                 │ MODIFIED                 │ 💭 THOUGHT       │
├──────────────────────────┼──────────────────────────┼──────────────────┤
│                          │                          │ PLAN             │
│ code here                │ code here                │ 1. Step one      │
│ - removed line           │ + added line             │ 2. Step two      │
│ code here                │ code here                │                  │
│                          │                          │ CONFIDENCE       │
│                          │                          │ Logic: ████████░ │
│                          │                          │        98%       │
└──────────────────────────┴──────────────────────────┴──────────────────┘
Removed: bg rgba(239,68,68,0.1)
Added:   bg rgba(34,197,94,0.1)
```
---
## Typography Scale
| Element | Size | Weight | Usage |
|---------|------|--------|-------|
| H1 | 24px | 700 | Modal titles |
| H2 | 20px | 600 | Panel headers |
| H3 | 16px | 600 | Section titles |
| Body | 14px | 400 | Primary text |
| Mono | 13px | 400 | Code, timestamps |
| Small | 12px | 400 | Labels, metadata |
| Tiny | 10px | 500 | Badges, status |
**Font Families:**
- Primary: Inter, system-ui
- Mono: JetBrains Mono, Fira Code, monospace
---
## Spacing System
```
space-xs:   4px   (tight gaps)
space-sm:   8px   (component internal)
space-md:   12px  (section padding)
space-lg:   16px  (panel padding)
space-xl:   24px  (major sections)
space-2xl:  32px  (layout gaps)
```
---
## Animations
| Animation | Duration | Usage |
|-----------|----------|-------|
| Panel slide | 200ms | Collapse/expand |
| Modal open | 150ms | Dialog appearance |
| Modal close | 100ms | Dialog dismissal |
| Tab switch | 150ms | Active indicator |
| Button press | 100ms | Scale feedback |
| Toast enter | 200ms | Notification |
| AI typing | 30ms/char | Streaming text |
**Easing:**
- Standard: cubic-bezier(0.4, 0, 0.2, 1)
- Decelerate: cubic-bezier(0, 0, 0.2, 1)
- Accelerate: cubic-bezier(0.4, 0, 1, 1)
---
## Keyboard Shortcuts
### Navigation
| Shortcut | Action |
|----------|--------|
| `Cmd/Ctrl + B` | Toggle left panel |
| `Cmd/Ctrl + J` | Toggle bottom panel |
| `Cmd/Ctrl + Shift + E` | Focus explorer |
| `Cmd/Ctrl + Shift + F` | Global search |
| `Cmd/Ctrl + Shift + O` | Toggle right panel |
| `Cmd/Ctrl + P` | Quick open file |
| `Cmd/Ctrl + Shift + P` | Command palette |
| `Cmd/Ctrl + Shift + M` | Focus AI terminal |
### Session Control
| Shortcut | Action |
|----------|--------|
| `Cmd/Ctrl + Enter` | Send AI message |
| `Cmd/Ctrl + .` | Stop session |
| `Cmd/Ctrl + Shift + .` | Restart session |
| `Esc` | Cancel/Close |
---
## Pi Harness Extension Points
```
Extension Manifest Structure:
{
  "name": "recipe-name",
  "type": "recipe|theme|prompt|cant",
  "display": {
    "icon": "⚡",
    "title": "Display Name",
    "description": "What it does"
  },
  "entry": "./index.ts",
  "capabilities": ["file-system", "shell-exec"]
}
Scope Resolution:
  Project > User > Global
  ./.pi/ext > ~/.pi/ext > ~/.config/cleo/pi/ext
```
---
## Responsive Breakpoints
| Breakpoint | Width | Layout |
|------------|-------|--------|
| Desktop XL | ≥1600px | Full 3-panel |
| Desktop | 1200-1599px | 3-panel, compact right |
| Laptop | 992-1199px | Collapsible right (overlay) |
| Tablet | 768-991px | Left overlay, no right |
| Mobile | <768px | Single panel, sheets |
---
## Design Principles
1. **Context Always Visible**: Code and AI side-by-side
2. **Progressive Disclosure**: Information hierarchy, not clutter
3. **Fast Feedback**: <100ms for UI interactions
4. **Extensible**: Plugin architecture for recipes/tools
5. **Accessible**: WCAG 2.1 AA compliance
6. **Lore-Aligned**: Workshop metaphor throughout
---
## File Structure
```
docs/design/
├── CLEO-PI-AGENT-TUI-DESIGN.md       # Complete design system
├── CLEO-PI-HARNESS-WIREFRAMES.md     # Detailed wireframes
├── CLEO-PI-HARNESS-ARCHITECTURE.md   # Architecture & integration
└── QUICK-REFERENCE.md                # This file
```
---
## Implementation Checklist
### MVP (Weeks 1-4)
- [ ] Layout shell with resizing
- [ ] Theme system
- [ ] File explorer
- [ ] Code editor
- [ ] Basic terminal
### Core AI (Weeks 5-8)
- [ ] Pi harness integration
- [ ] AI streaming terminal
- [ ] Session management
- [ ] Recipe grid
### Advanced (Weeks 9-12)
- [ ] Diff viewer
- [ ] Pipeline status
- [ ] Resource monitoring
- [ ] Cross-project features
### Polish (Weeks 13-14)
- [ ] Animations
- [ ] Accessibility
- [ ] Performance
- [ ] Documentation
---
## Summary
**CleoOS** is an AI-first IDE where:
- The **Pi Harness** provides agent capabilities
- The **Circle of Ten** manifests as functional UI aspects
- **The Hearth** is the collaborative workshop surface
- **Three-tier scope** ensures flexibility
**Key Visual:**
- Dark forge aesthetic (#0a0a0f background)
- Purple AI accents (#a855f7)
- High-density information layout
- Three-panel workspace
- Real-time AI collaboration
This design system enables seamless human-AI collaboration in a cohesive, lore-rich development environment
