# CleoOS - Pi Harness UI Architecture
## The Hearth: Where Pi Meets the Circle of Ten
This document defines the architectural integration between the Pi Code Agent harness, the Circle of Ten role system, and the CleoOS TUI interface.
---
## Conceptual Foundation
### The Workshop Metaphor
In Cleo's lore, the development environment is a **workshop** where different aspects (Circle of Ten) perform specialized roles. The Hearth is the terminal-facing workshop surface where:
- **Threads** (tasks) are forged by The Smiths
- **Looms** (pipelines) are woven by The Weavers  
- **Motion** (orchestration) is conducted by The Conductors
- **Cogs** (tools) are crafted by The Artificers
- **Memories** are archived by The Archivists
- **Context** is held by The Scribes
- **Quality** is guarded by The Wardens
- **Cross-project** paths are found by The Wayfinders
- **Captures** are caught by The Catchers
- **Continuity** is kept by The Keepers
### The Pi Harness as Central Conduit
The Pi harness becomes the **primary conduit** through which all agent capabilities flow into The Hearth. Unlike other providers that speak through MCP (Model Context Protocol), Pi speaks natively through:
1. **Extensions** - Modular capabilities (skills, tools, recipes)
2. **Instructions** - Context injection at project/user/global scope
3. **Themes** - Visual customization
4. **Prompts** - Reusable conversation templates
5. **CANT Profiles** - Navigation and execution profiles
---
## Architecture Overview
```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           CLEOOS - THE HEARTH                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                         PI CODE AGENT HARNESS                       │   │
│  │                                                                     │   │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌───────────┐  │   │
│  │  │ Extensions  │  │Instructions │  │   Themes    │  │  Prompts  │  │   │
│  │  │  (Skills)   │  │  (Context)  │  │   (Visual)  │  │ (Recipes) │  │   │
│  │  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └─────┬─────┘  │   │
│  │         │                │                │               │        │   │
│  │         └────────────────┴────────────────┴───────────────┘        │   │
│  │                              │                                      │   │
│  │                              ▼                                      │   │
│  │  ┌─────────────────────────────────────────────────────────────┐   │   │
│  │  │                    PI HARNESS CORE                          │   │   │
│  │  │  • Session lifecycle management                             │   │   │
│  │  │  • Streaming response handling                              │   │   │
│  │  │  • Extension loading (3-tier scope)                         │   │   │
│  │  │  • CANT profile execution                                   │   │   │
│  │  │  • Theme application                                        │   │   │
│  │  └─────────────────────────────┬───────────────────────────────┘   │   │
│  │                                │                                   │   │
│  │         ┌──────────────────────┼──────────────────────┐            │   │
│  │         │                      │                      │            │   │
│  │         ▼                      ▼                      ▼            │   │
│  │  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐          │   │
│  │  │   Session    │    │   Stream     │    │   Command    │          │   │
│  │  │    Events    │    │   Events     │    │   Events     │          │   │
│  │  └──────────────┘    └──────────────┘    └──────────────┘          │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                    │                                        │
│                                    ▼                                        │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                      CIRCLE OF TEN MANIFESTATION                    │   │
│  │                                                                     │   │
│  │  ┌───────────┬───────────┬───────────┬───────────┬───────────────┐ │   │
│  │  │  SMITHS   │  WEAVERS  │CONDUCTORS │ARTIFICERS │  ARCHIVISTS   │ │   │
│  │  │  (tasks)  │(pipeline) │(orchestra)│  (tools)  │   (memory)    │ │   │
│  │  ├───────────┼───────────┼───────────┼───────────┼───────────────┤ │   │
│  │  │Task Tree  │Pipeline   │Session    │Recipe     │Memory Search  │ │   │
│  │  │Epic View  │Status Bar │Manager    │Grid       │Panel          │ │   │
│  │  │Todo List  │Stage Gates│Spawn Card │Tool Chest │Observations   │ │   │
│  │  └───────────┴───────────┴───────────┴───────────┴───────────────┘ │   │
│  │  ┌───────────┬───────────┬───────────┬───────────┬───────────────┐ │   │
│  │  │  SCRIBES  │  WARDENS  │WAYFINDERS │  CATCHERS │    KEEPERS    │ │   │
│  │  │ (session) │  (check)  │  (nexus)  │  (sticky) │    (admin)    │ │   │
│  │  ├───────────┼───────────┼───────────┼───────────┼───────────────┤ │   │
│  │  │Session    │Validation │Project    │Quick      │System Status  │ │   │
│  │  │Notes      │Badges     │Switcher   │Capture    │Health Monitor │ │   │
│  │  │Handoff    │Quality    │Nexus      │Sticky Wall│Backup Controls│ │   │
│  │  └───────────┴───────────┴───────────┴───────────┴───────────────┘ │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                    │                                        │
│                                    ▼                                        │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                         UI SURFACE LAYER                            │   │
│  │                                                                     │   │
│  │  ┌──────────┐  ┌──────────────────────────────┐  ┌──────────────┐  │   │
│  │  │   LEFT   │  │          CENTER              │  │    RIGHT     │  │   │
│  │  │  PANEL   │  │         WORKSPACE            │  │    PANEL     │  │   │
│  │  │          │  │                              │  │              │  │   │
│  │  │[Archive] │  │[Forge]    [Impulse Stream]   │  │ [Loom Sta-  │  │   │
│  │  │Explorer  │  │Editor  +  AI Terminal        │  │   tion]      │  │   │
│  │  │Git Tree  │  │Code       Streaming          │  │ Session Mgr  │  │   │
│  │  │          │  │Diff       Responses          │  │ Recipe Grid  │  │   │
│  │  │          │  │Preview    Thought Process    │  │ Metrics      │  │   │
│  │  └──────────┘  └──────────────────────────────┘  └──────────────┘  │   │
│  │                                                                     │   │
│  │  ┌────────────────────────────────────────────────────────────────┐ │   │
│  │  │                    BOTTOM PANEL                               │ │   │
│  │  │  [Conduit] - Terminal interface for agent communication       │ │   │
│  │  │  Command palette, logs, system console                        │ │   │
│  │  └────────────────────────────────────────────────────────────────┘ │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```
---
## Component-to-Domain Mapping
### Left Panel: The Archive (Archivists + Wayfinders)
| Component | Domain | Aspect | Function |
|-----------|--------|--------|----------|
| File Explorer Tree | tasks | The Smiths | Navigate work threads |
| Git Status Indicator | tasks | The Smiths | Track changes to threads |
| Project Switcher | nexus | The Wayfinders | Navigate star road |
| Global Search | memory | The Archivists | Recall from archive |
| Sticky Notes Wall | sticky | The Catchers | Quick capture shelf |
**File Tree Specifications:**
```
Visual Design:
┌─────────────────────────────┐
│ 📁 src                      │
│   📁 components             │
│     📄 Button.tsx        [M]│  ← Git modified
│     📄 Card.tsx             │
│   📁 config                 │
│     📄 action.config.ts  [U]│  ← Git untracked
│ 📄 package.json             │
│ 📄 README.md                │
└─────────────────────────────┘
Git Badges:
[M] = Modified (yellow dot)
[U] = Untracked (green dot)
[D] = Deleted (red dot)
[●] = Staged (blue dot)
```
### Center Workspace: The Forge (Smiths + Scribes)
| Component | Domain | Aspect | Function |
|-----------|--------|--------|----------|
| Code Editor | tasks | The Smiths | Forge threads |
| Diff Viewer | check | The Wardens | Judge changes |
| Live Preview | check | The Wardens | Validate output |
| AI Terminal | session | The Scribes | Hold context |
| Command Palette | tools | The Artificers | Invoke cogs |
**Editor + AI Split Layout:**
```
┌──────────────────────────────────────────────┬─────────────────────────────┐
│ action.config.ts                        [×]  │ [⚡] Pi Code AI            │
├──────────────────────────────────────────────┼─────────────────────────────┤
│                                              │                             │
│ 1  import { defineConfig } from '@cleo/     │ [⚡] Executing plan...      │
│ 2    core';                                 │                             │
│ 3                                           │ ┌─────────────────────────┐ │
│ 4  export default defineConfig({           │ │ Analyzing Theme Tokens  │ │
│ 5    version: '2.4.0',                     │ │ ████████████░░░ 85%     │ │
│ 6    features: {                           │ └─────────────────────────┘ │
│ 7      orchestration: true,                │                             │
│ 8      ai_streaming: true,                 │ Applying Tailwind...        │
│ 9    },                                    │                             │
│ 10   styles: {                             │                             │
│ 11     buttons: {                          │                             │
│ 12       radius: 'sm',                     │                             │
│ 13     }                                   │                             │
│ 14   }                                     │                             │
│ 15 });                                     │                             │
│                                              │                             │
└──────────────────────────────────────────────┴─────────────────────────────┘
        The Forge (60%)                          The Impulse Stream (40%)
        The Smiths at work                       The Scribes recording
```
### Right Panel: The Loom Station (Weavers + Conductors + Artificers)
| Component | Domain | Aspect | Function |
|-----------|--------|--------|----------|
| Session Manager | orchestrate | The Conductors | Assign motion |
| Pipeline Status | pipeline | The Weavers | Mount looms |
| Recipe Grid | tools | The Artificers | Supply cogs |
| Resource Monitor | admin | The Keepers | Maintain health |
| Quick Actions | tools | The Artificers | Fast cogs |
**Session Card Anatomy:**
```
┌───────────────────────────────────────────────────────────────┐
│ ● frontend-refactor                       [● ACTIVE]          │
│                                                              │
│ ┌─────────────┐  ┌─────────────┐  ┌─────────────┐           │
│ │  ⏹ Stop     │  │ 🔄 Restart  │  │ 🗑 Delete    │           │
│ └─────────────┘  └─────────────┘  └─────────────┘           │
│                                                              │
│ Duration: 02:45:12  │  Memory: 💾 1.2GB                      │
│                                                              │
│ Progress:                                                    │
│ ████████████████████████████████████████████████░░░░░  92%   │
│                                                              │
│ Current: "Optimizing bundle size..."                         │
└───────────────────────────────────────────────────────────────┘
        ↑
   The Conductor's
   Motion Assignment
```
### Bottom Panel: The Conduit (Scribes + Catchers)
| Component | Domain | Aspect | Function |
|-----------|--------|--------|----------|
| AI Terminal | session | The Scribes | Real-time context |
| Command Input | tools | The Artificers | Direct cog invocation |
| Quick Capture | sticky | The Catchers | Sticky note creation |
| Logs Viewer | admin | The Keepers | System continuity |
**Terminal with AI Integration:**
```
┌──────────────────────────────────────────────────────────────────────────────┐
│ CLEO AI TERMINAL                                       ● IDLE  │ ⬇ │ ×    │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│ [system] Environment initialized for DraftFrame v2.4.0                       │
│ [system] Loaded 12 extensions, 4 themes, 3 CANT profiles                     │
│ [system] Local server running at http://localhost:3000                       │
│                                                                              │
│ ───────────────────────────────────────────────────────────────────────────  │
│                                                                              │
│ > Implement user authentication using JWT tokens                             │
│                                                                              │
│ [⚡] Cleo AI is thinking...                                                  │
│                                                                              │
│ 💭 Plan:                                                                     │
│   1. Install required dependencies (jsonwebtoken, bcrypt)                    │
│   2. Create auth middleware                                                  │
│   3. Implement login/register endpoints                                      │
│   4. Add token refresh logic                                                 │
│                                                                              │
│ I'll implement JWT authentication for your application. Starting with...     │
│                                                                              │
│ [Running: npm install jsonwebtoken bcrypt @types/jsonwebtoken]               │
│ ✓ Dependencies installed (2.4s)                                              │
│                                                                              │
│ [Creating: src/middleware/auth.ts]                                           │
│ ┌──────────────────────────────────────────────────────────────────────────┐ │
│ │ import jwt from 'jsonwebtoken';                                          │ │
│ │ import bcrypt from 'bcrypt';                                             │ │
│ │                                                                          │ │
│ │ export const authMiddleware = ...                                        │ │
│ └──────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│ [Apply Changes]  [View Diff]  [Regenerate]  [Dismiss]                        │
│                                                                              │
│ ───────────────────────────────────────────────────────────────────────────  │
│                                                                              │
│ > │                                                                          │
│   ▲ Caret pulses with accent-primary                                         │
└──────────────────────────────────────────────────────────────────────────────┘
```
---
## Pi Harness Extension Points
### Extension Loading (3-Tier Scope)
```
Scope Hierarchy:
┌─────────────────────────────────────────────────────────────────┐
│                        GLOBAL                                   │
│              ~/.config/cleo/pi/extensions/                      │
│                         ▲                                       │
│                         │ Lowest priority                       │
│              ┌──────────┴──────────┐                            │
│              │        USER         │                            │
│              │  ~/.pi/extensions/  │                            │
│              │         ▲           │                            │
│              │         │ Medium    │                            │
│              │    ┌────┴────┐      │                            │
│              │    │ PROJECT │      │                            │
│              │    │./.pi/ext│      │                            │
│              │    │  ▲      │      │                            │
│              │    │  │High  │      │                            │
│              └────┴──┴──────┴──────┘                            │
│                                                                 │
│  Resolution: Project > User > Global                            │
└─────────────────────────────────────────────────────────────────┘
```
**Extension Manifest:**
```json
{
  "name": "drizzle-migration-recipe",
  "version": "1.0.0",
  "type": "recipe",
  "display": {
    "icon": "🛠",
    "title": "Drizzle Migration",
    "description": "Generate and run database migrations"
  },
  "entry": "./index.ts",
  "capabilities": ["file-system", "shell-exec", "database"],
  "triggers": ["on-db-change", "manual"]
}
```
### Recipe Grid System
```
Recipes manifest as interactive cards in the right panel:
┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│      ⚡      │ │      🛠      │ │      ⚡      │ │      📜      │
│   Nuxt Hydrate│ │ Drizzle Mig  │ │   Jest Clean │ │ Shell Script │
│              │ │              │ │              │ │              │
│ [Run] [Edit] │ │ [Run] [Edit] │ │ [Run] [Edit] │ │ [Run] [Edit] │
└──────────────┘ └──────────────┘ └──────────────┘ └──────────────┘
Categories:
⚡ Performance    🛠 Database    🧪 Testing    📜 Scripts
🔄 Git Ops       🔒 Security     🎨 Styles    🐛 Debug
```
### CANT Profile Integration
CANT (Code Agent Navigation Tool) profiles appear as **navigation modes** in the UI:
```
Navigation Mode Selector:
┌──────────────────────────────────────────────────────┐
│ [Explore] [Refactor] [Debug] [Test] [Document]  [▼]  │
└──────────────────────────────────────────────────────┘
Each mode loads a CANT profile that configures:
- Default extensions active
- System instructions
- Available recipes
- Key bindings
- UI layout preference
```
---
## State Flow Architecture
### Session Lifecycle
```
User Intent → Looming Engine → Thread Creation → Execution
     │              │               │              │
     ▼              ▼               ▼              ▼
┌─────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐
│  Input  │   │ Tessera  │   │   Task   │   │ Session  │
│Capture  │ → │ Decomp.  │ → │  Tree    │ → │  Spawn   │
└─────────┘   └──────────┘   └──────────┘   └────┬─────┘
                                                  │
                   ┌──────────────────────────────┼──────────────┐
                   │                              │              │
                   ▼                              ▼              ▼
            ┌────────────┐               ┌────────────┐  ┌────────────┐
            │   Stream   │               │   Watch    │  │   Refinery │
            │   Events   │               │   Patrol   │  │   Gate     │
            └────────────┘               └────────────┘  └────────────┘
                   │                              │              │
                   └──────────────────────────────┴──────────────┘
                                                  │
                                                  ▼
                                           ┌────────────┐
                                           │  Living    │
                                           │  BRAIN     │
                                           │  Archive   │
                                           └────────────┘
```
### Event System
```typescript
// Core event types flowing through The Hearth
interface HearthEvents {
  // Session events (The Scribes)
  'session:start': { sessionId: string; intent: string };
  'session:stream': { sessionId: string; chunk: string };
  'session:complete': { sessionId: string; result: TaskResult };
  
  // Task events (The Smiths)
  'task:create': { taskId: string; parentId?: string };
  'task:update': { taskId: string; updates: Partial<Task> };
  'task:complete': { taskId: string; artifacts: string[] };
  
  // Orchestration events (The Conductors)
  'orchestrate:spawn': { sessionId: string; agent: AgentConfig };
  'orchestrate:status': { sessionId: string; status: AgentStatus };
  
  // Memory events (The Archivists)
  'memory:observe': { observation: Observation };
  'memory:pattern': { pattern: Pattern };
  
  // Tool events (The Artificers)
  'tool:invoke': { tool: string; params: unknown };
  'tool:result': { tool: string; result: unknown };
  
  // Validation events (The Wardens)
  'check:validation': { passed: boolean; issues: Issue[] };
  'check:quality': { score: number; metrics: Metrics };
}
```
---
## Theme Integration
### Visual Theme System
Themes loaded through Pi harness affect:
```
Theme Variables:
┌────────────────────────────────────────────────────────────────┐
│                                                                │
│  CSS Custom Properties:                                        │
│  ─────────────────────                                         │
│  --color-bg-primary: #0a0a0f      (main background)            │
│  --color-bg-secondary: #13131f    (panels)                     │
│  --color-accent-primary: #a855f7  (Pi AI purple)               │
│  --color-accent-secondary: #ec4899 (secondary pink)            │
│  --font-mono: 'JetBrains Mono'    (code)                       │
│  --density: compact | comfortable | spacious                   │
│                                                                │
│  Applied to:                                                   │
│  • Editor color scheme (Monaco/CodeMirror theme)               │
│  • Terminal color palette (xterm.js)                           │
│  • UI component styling                                        │
│  • Syntax highlighting                                         │
│  • Chart/visualization colors                                  │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```
### Lore-Themed Visual Modes
```
Available Themes:
1. Forgemaster (Default)
   - Dark forge aesthetic
   - Amber and steel accents
   - Inspired by The Smiths
2. Weaver's Loom
   - Thread and tapestry motifs
   - Gradient threads as accents
   - Inspired by The Weavers
3. Astral Path
   - Deep space purples
   - Star navigation elements
   - Inspired by The Wayfinders
4. Archive Vault
   - Sepia and parchment
   - Classical typography
   - Inspired by The Archivists
5. Synth Wave
   - Neon on dark
   - Retro-futuristic
   - Inspired by cyberpunk aesthetic
```
---
## Keyboard Shortcuts
### The Hearth Navigation
| Shortcut | Action | Aspect |
|----------|--------|--------|
| `Cmd/Ctrl + B` | Toggle Archive (left) | Archivists |
| `Cmd/Ctrl + J` | Toggle Conduit (bottom) | Scribes |
| `Cmd/Ctrl + Shift + E` | Focus Explorer | Archivists |
| `Cmd/Ctrl + Shift + F` | Global Search | Wayfinders |
| `Cmd/Ctrl + Shift + G` | Focus Git | Smiths |
| `Cmd/Ctrl + Shift + M` | Focus AI Terminal | Scribes |
| `Cmd/Ctrl + Shift + O` | Toggle Loom Station (right) | Weavers |
| `Cmd/Ctrl + Shift + R` | Recipe palette | Artificers |
### Session Control
| Shortcut | Action | Aspect |
|----------|--------|--------|
| `Cmd/Ctrl + Enter` | Send AI message | Scribes |
| `Cmd/Ctrl + Shift + Enter` | Send with context | Scribes |
| `Cmd/Ctrl + .` | Stop current session | Conductors |
| `Cmd/Ctrl + Shift + .` | Restart session | Conductors |
| `Esc` | Cancel/Close | - |
### Quick Capture (The Catchers)
| Shortcut | Action |
|----------|--------|
| `Cmd/Ctrl + Shift + N` | New sticky note |
| `Cmd/Ctrl + Shift + T` | New task from selection |
| `Cmd/Ctrl + Shift + O` | Observe to memory |
---
## Implementation Roadmap
### Phase 1: Foundation (MVP)
**Week 1-2: Shell Architecture**
- [ ] Three-panel layout with resizing
- [ ] Theme system with CSS variables
- [ ] Basic Pi harness integration
- [ ] Session management UI
**Week 3-4: Core Work Surfaces**
- [ ] File explorer (Archive)
- [ ] Code editor integration
- [ ] Basic terminal (Conduit)
- [ ] Session cards (Loom Station)
### Phase 2: AI Integration
**Week 5-6: Pi Harness Features**
- [ ] Extension loading UI
- [ ] Recipe grid system
- [ ] AI streaming terminal
- [ ] Diff viewer
**Week 7-8: Context Management**
- [ ] Memory panel (Archivists)
- [ ] Session notes (Scribes)
- [ ] Context window visualization
- [ ] Handoff system
### Phase 3: Advanced Features
**Week 9-10: Pipeline & Orchestration**
- [ ] Pipeline status (Weavers)
- [ ] Session orchestration (Conductors)
- [ ] Resource monitoring (Keepers)
- [ ] Validation badges (Wardens)
**Week 11-12: Cross-Project**
- [ ] Project switcher (Wayfinders)
- [ ] Nexus integration
- [ ] Sticky notes (Catchers)
- [ ] Admin panel (Keepers)
### Phase 4: Polish
**Week 13-14:**
- [ ] Animations and transitions
- [ ] Accessibility audit
- [ ] Performance optimization
- [ ] Documentation
---
## Summary
The CleoOS Pi Harness UI architecture creates a cohesive development environment where:
1. **The Pi Harness** provides first-class agent capabilities through extensions, instructions, and streaming
2. **The Circle of Ten** manifests as functional UI aspects with clear responsibilities:
   - **Left Panel** (Archive): Archivists + Wayfinders + Catchers
   - **Center** (Forge): Smiths + Scribes + Wardens
   - **Right Panel** (Loom Station): Weavers + Conductors + Artificers + Keepers
   - **Bottom** (Conduit): Scribes + Catchers
3. **The Workshop Metaphor** makes the system intuitive:
   - Threads are forged
   - Looms are woven
   - Motion is conducted
   - Cogs are supplied
   - Memory is archived
4. **Three-Tier Scope** ensures flexibility while maintaining project isolation
The result is an AI-first IDE where the boundary between human and agent work dissolves into a seamless collaborative workshop.
