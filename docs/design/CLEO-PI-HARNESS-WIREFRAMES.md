# CLEO Pi Harness - Wireframe Specifications
## Overview
Detailed wireframe specifications for the Pi Code Agent harness interface in CleoOS. These wireframes define the exact layout, component placement, and interaction patterns.
---
## Global Layout Structure
### Base Grid System
```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                    100vw                                    │
│  ┌──────────┬──────────────────────────────────────┬──────────────────┐     │
│  │          │                                      │                  │     │
│  │  240px   │         flexible (1fr)               │     300px        │     │
│  │  LEFT    │          CENTER                      │     RIGHT        │     │
│  │  PANEL   │          WORKSPACE                   │     PANEL        │     │
│  │          │                                      │                  │     │
│  ├──────────┼──────────────────────────────────────┼──────────────────┤     │
│  │          │          BOTTOM TERMINAL             │                  │     │
│  │          │          (200px - collapsible)       │                  │     │
│  └──────────┴──────────────────────────────────────┴──────────────────┘     │
│                                                                             │
│  Total: 100vw × 100vh                                                       │
└─────────────────────────────────────────────────────────────────────────────┘
```
### Resizable Regions
```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                   HEADER (48px)                             │
├─────────────────────────────────────────────────────────────────────────────┤
│   ↕   │                    ↕                                    │     ↕      │
│   │   │                    │                                    │     │      │
│   │   │                    │                                    │     │      │
│   │   │                    │                                    │     │      │
│   │   │                    │                                    │     │      │
│ 240px │                 1fr                                  │   300px    │
│   │   │                    │                                    │     │      │
│   │   │                    │                                    │     │      │
│   │   │                    │                                    │     │      │
│   │   │                    │                                    │     │      │
│   ↕   │                    ↕                                    │     ↕      │
├───────┴────────────────────┴────────────────────────────────────┴───────────┤
│                              BOTTOM (0-400px)                               │
│                                  ↕ resizable                                │
└─────────────────────────────────────────────────────────────────────────────┘
```
---
## Screen 1: Welcome / Empty State
### Layout
```
┌─────────────────────────────────────────────────────────────────────────────┐
│ [C] CleoOS        Editor   Terminal   Live Preview   Logs        [🔍] [👤]  │
├─────────────────────────────────────────────────────────────────────────────┤
│  ┌──────────┐                                                               │
│  │ EXPLORER │                                                               │
│  │          │                                                               │
│  │ DRAFTFRAME│                                                              │
│  │ 📁 src   │                                                               │
│  │   📄 App │                                                               │
│  │   📄 ind │                                                               │
│  │   📄 mai │                                                               │
│  │ 📄 packa │                                                               │
│  │ 📄 READM │                                                               │
│  │          │                                                               │
│  │          │                                                               │
│  │          │                                                               │
│  │          │                                                               │
│  ├──────────┤                                                               │
│  │ 🌿 main ▼│                                                               │
│  └──────────┘                                                               │
│                                                                             │
│                                    [Logo]                                   │
│                              ┌─────────────────┐                           │
│                              │   ▓▓▓▓▓▓▓▓▓▓▓   │                           │
│                              │   ▓        ▓    │                           │
│                              │   ▓   ⚡   ▓    │   Your workspace is ready  │
│                              │   ▓        ▓    │                           │
│                              │   ▓▓▓▓▓▓▓▓▓▓▓   │                           │
│                              └─────────────────┘                           │
│                                                                             │
│                  The environment for DraftFrame has been provisioned.       │
│                       Connect your agent to begin orchestration.            │
│                                                                             │
│                         ┌─────────────┐  ┌─────────────┐                   │
│                         │  ▶ Start    │  │  ⌨  Open    │                   │
│                         │   Session   │  │   Terminal  │                   │
│                         └─────────────┘  └─────────────┘                   │
│                                                                             │
│  ┌───────────────────────────────────────────────────────────────────────┐ │
│  │ CLEO AI TERMINAL                                    ● IDLE  │ ⬇ │ ×  │ │
│  │                                                                       │ │
│  │ [system] environment initialized for DraftFrame...                    │ │
│  │ [system] local server running at localhost:3000                       │ │
│  │                                                                       │ │
│  │ > │                                                                   │ │
│  └───────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
```
### Component Details
**Logo (Center)**
- Size: 96px × 96px
- Gradient: accent-primary → accent-secondary
- Animation: Subtle pulse glow
**Primary CTA Button**
```
┌─────────────────────────────────────┐
│     ▶  Start Session                │
└─────────────────────────────────────┘
Width: 180px
Height: 44px
Background: linear-gradient(135deg, #a855f7, #ec4899)
Border-radius: 6px
Font: 14px, weight 600, white
Hover: brightness 1.1 + glow
```
**Secondary CTA Button**
```
┌─────────────────────────────────────┐
│     ⌨  Open Terminal                │
└─────────────────────────────────────┘
Width: 180px
Height: 44px
Background: #1a1a2e
Border: 1px solid #2a2a3e
Border-radius: 6px
Font: 14px, weight 500
Hover: background #252538
```
---
## Screen 2: Active Workspace (Side-by-Side)
### Layout
```
┌─────────────────────────────────────────────────────────────────────────────┐
│ [C] CleoOS        [Editor]  Terminal  Live Preview  Logs       [🔍] [👤]  │
├─────────────────────────────────────────────────────────────────────────────┤
│  ┌──────────┐  ┌────────────────────────────────┬──────────────────────┐   │
│  │          │  │ action.config.ts          [×]  │  [⚡] Pi Code AI    │   │
│  │ EXPLORER │  ├────────────────────────────────┼──────────────────────┤   │
│  │          │  │                                │                      │   │
│  │ DRAFTFRA │  │  1 │ import { defineConfig }  │ [⚡] Executing plan  │   │
│  │          │  │  2 │   from '@cleo/core';     │      to update       │   │
│  │ 📁 src   │  │  3 │                          │      button styles...│   │
│  │   📁 com │  │  4 │ export default           │                      │   │
│  │   📁 con │  │  5 │ defineConfig({           │ ┌──────────────────┐ │   │
│  │   📄 act │◄─┼─ 6 │   version: '2.4.0',      │ │ Analyzing Theme  │ │   │
│  │   📄 ind │  │  7 │   features: {            │ │ Tokens      85%  │ │   │
│  │ 📄 packa │  │  8 │     orchestration: true, │ │ ████████████░░░  │ │   │
│  │ 📄 READM │  │  9 │     ai_streaming: true,  │ └──────────────────┘ │   │
│  │          │  │ 10 │   },                     │                      │   │
│  │          │  │ 11 │   styles: {              │ Applying Tailwind    │   │
│  │          │  │ 12 │     // Update button     │ radius-sm to         │   │
│  │          │  │ 13 │     // aesthetics        │ secondary-fixed      │   │
│  │          │  │ 14 │     buttons: {           │ containers...        │   │
│  │          │  │ 15 │       radius: 'sm',      │                      │   │
│  │          │  │ 16 │       elevation:         │                      │   │
│  │          │  │ 17 │         'ambient'        │                      │   │
│  │          │  │ 18 │     }                    │                      │   │
│  │          │  │ 19 │   }                      │                      │   │
│  │          │  │ 20 │ });                      │                      │   │
│  │          │  │                                │                      │   │
│  │          │  │                                │                      │   │
│  │          │  │                                │                      │   │
│  ├──────────┤  │                                │                      │   │
│  │ 🌿 main ▼│  │                                │                      │   │
│  └──────────┘  └────────────────────────────────┴──────────────────────┘   │
│  ┌───────────────────────────────────────────────────────────────────────┐ │
│  │ Pi is updating action.config.ts                          [CANCEL] [✓]│ │
│  └───────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
```
### Component Details
**Editor Panel (Left Split)**
```
Width: 60% of center area
Background: #0a0a0f
Border-right: 1px solid #2a2a3e
```
**AI Terminal (Right Split)**
```
Width: 40% of center area
Background: #13131f
```
**Progress Card**
```
┌─────────────────────────────────────┐
│ Analyzing Theme Tokens        85%   │
│ ████████████████████████████░░░░░░░ │
└─────────────────────────────────────┘
Background: #1a1a2e
Border-radius: 6px
Padding: 12px
Progress bar: 4px height, gradient fill
```
**Floating Action Bar**
```
Position: fixed, bottom 16px, center
Background: #1a1a2e
Border: 1px solid #2a2a3e
Border-radius: 8px
Padding: 8px 16px
Shadow: 0 4px 20px rgba(0,0,0,0.5)
```
---
## Screen 3: Terminal-Full Mode with Sessions
### Layout
```
┌─────────────────────────────────────────────────────────────────────────────┐
│ [C] CleoOS        Editor  [Terminal]  Live Preview  Logs       [🔍] [👤]  │
├─────────────────────────────────────────────────────────────────────────────┤
│  ┌──────────┐  ┌────────────────────────────────────────────────────────┐  │
│  │          │  │ cleo list-active-sessions                              │  │
│  │ EXPLORER │  │                                                        │  │
│  │          │  │  Session ID          Status      Duration              │  │
│  │ 📁 src   │  │  ────────────────────────────────────────────────     │  │
│  │   📄 App │  │  frontend-refactor   🟢 Running   02:45:12             │  │
│  │   📄 ind │  │  api-integration     🟡 Paused    00:12:05             │  │
│  │ 📄 packa │  │                                                        │  │
│  │          │  │  [⚙️] Cleo AI  SYNTHESIZING                            │  │
│  │          │  │  ═══════════════════════════════════════════════════   │  │
│  │          │  │                                                        │  │
│  │          │  │  I've analyzed the frontend-refactor session. The      │  │
│  │          │  │  current bottlenecks are in the /components/Navigation │  │
│  │          │  │  tree. Would you like me to initiate a tree-shaking    │  │
│  │          │  │  recipe?                                               │  │
│  │          │  │                                                        │  │
│  │          │  │  ┌─────────────────────┐ ┌─────────────┐              │  │
│  │          │  │  │ Execute Recipe:     │ │ View Details│              │  │
│  │          │  │  │ Tree-Shake          │ │             │              │  │
│  │          │  │  └─────────────────────┘ └─────────────┘              │  │
│  │          │  │                                                        │  │
│  │          │  │  > │                                                   │  │
│  │          │  │                                                        │  │
│  └──────────┘  └────────────────────────────────────────────────────────┘  │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │ ORCHESTRATION                                            [👤] [⚡] [📊]│
│  ├─────────────────────────────────────────────────────────────────────┤   │
│  │ Active Session: None                                                │   │
│  ├─────────────────────────────────────────────────────────────────────┤   │
│  │ SESSIONS                                                            │   │
│  │                                                                     │   │
│  │ ┌─────────────────────────────────────────────────────────────────┐│   │
│  │ │ ● frontend-refactor                                 [● ACTIVE]  ││   │
│  │ │   02:45:12  │  💾 1.2GB                                     │   ││   │
│  │ │                                                                   ││   │
│  │ │ [⏹] [🔄] [🗑]                                                   ││   │
│  │ └─────────────────────────────────────────────────────────────────┘│   │
│  │                                                                     │   │
│  │ ┌─────────────────────────────────────────────────────────────────┐│   │
│  │ │ ● api-integration                                   [● PAUSED]  ││   │
│  │ │   00:12:05  │  💾 340MB                                     │   ││   │
│  │ │                                                                   ││   │
│  │ │ [▶] [🔄] [🗑]                                                   ││   │
│  │ └─────────────────────────────────────────────────────────────────┘│   │
│  │                                                                     │   │
│  │ ┌─────────────────────────────────────────────────────────────────┐│   │
│  │ │ ● unit-tests                                       [● FAILED]   ││   │
│  │ │   00:00:45  │  💾 89MB                                      │   ││   │
│  │ │                                                                   ││   │
│  │ │ [🔁 Retry] [📋 Logs] [🗑]                                       ││   │
│  │ └─────────────────────────────────────────────────────────────────┘│   │
│  ├─────────────────────────────────────────────────────────────────────┤   │
│  │ RECIPES                                                   [filter ▼]│   │
│  │ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐                 │   │
│  │ │    ⚡    │ │    🛠    │ │    ⚡    │ │    📜    │                 │   │
│  │ │   GIT    │ │  QUALITY │ │   DEPS   │ │   DEBUG  │                 │   │
│  │ └──────────┘ └──────────┘ └──────────┘ └──────────┘                 │   │
│  ├─────────────────────────────────────────────────────────────────────┤   │
│  │ RESOURCE LOAD                                                       │   │
│  │ Synthetic Intelligence                     ████████████░░ 84%       │   │
│  │ Cluster Throughput                         ██████░░░░░░░░ 32.4 GB/s │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
```
### Component Details
**Session Card - Active**
```
┌─────────────────────────────────────────────────────────────────┐
│ ● frontend-refactor                       [● ACTIVE]            │
│   02:45:12  │  💾 1.2GB                                       │
│                                                                 │
│ [⏹] [🔄] [🗑]                                                  │
└─────────────────────────────────────────────────────────────────┘
Background: #1a1a2e
Border: 1px solid #4a4a5e (active glow)
Border-radius: 8px
Padding: 12px
Status dot: 8px green (#22c55e)
```
**Session Card - Paused**
```
Status dot: 8px yellow (#f59e0b)
Border: 1px solid #2a2a3e
```
**Session Card - Failed**
```
Status dot: 8px red (#ef4444)
Border: 1px solid #ef4444 (error glow)
```
**Recipe Category Grid**
```
Card size: 64px × 64px
Background: #1a1a2e
Border-radius: 8px
Icon: 24px, accent color
Label: 10px uppercase, centered
Hover: background #252538 + border #4a4a5e
```
**Resource Bar**
```
Label: 12px text-secondary
Value: 12px mono text-primary, right-aligned
Bar: 4px height
  - Background: #2a2a3e
  - Fill: gradient accent-primary → accent-secondary
```
---
## Screen 4: Diff View with AI Thought Panel
### Layout
```
┌─────────────────────────────────────────────────────────────────────────────┐
│ [C] CleoOS        [Editor]  Terminal  Live Preview  Logs       [🔍] [👤]  │
├─────────────────────────────────────────────────────────────────────────────┤
│  ┌──────────┐  ┌────────────────────────────────────────────────────────┐  │
│  │          │  │ 📄 action.config.ts (Working Tree)    -2   +3    [×]   │  │
│  │ EXPLORER │  ├────────────────────────────────────────────────────────┤  │
│  │          │  │ ORIGINAL        │ MODIFIED        │ 💭 THOUGHT           │  │
│  │ 📁 src   │  ├─────────────────┼─────────────────┼──────────────────────┤  │
│  │   📁 com │  │                 │                 │ PLAN                 │  │
│  │   📁 con │  │ import {        │ import {        │ 1 Parse config schema│  │
│  │   📄 act │◄─┼─ defineConfig   │ defineConfig    │ 2 Map orchestration →│  │
│  │   📄 ind │  │ } from '@cleo/  │ } from '@cleo/  │   capabilities       │  │
│  │ 📄 packa │  │   core';        │   core';        │ 3 Inject auto-heal   │  │
│  │          │  │                 │                 │   hook               │  │
│  │          │  │ export default  │ export default  │                      │  │
│  │          │  │ defineConfig({  │ defineConfig({  │ ═══════════════════  │  │
│  │          │  │   version:      │   version:      │ CONFIDENCE           │  │
│  │          │  │     '2.4.0',    │     '2.4.0',    │                      │  │
│  │          │  │   features: {   │   capabilities: │ Logic    █████████░  │  │
│  │          │  │-    orchestra-  │+    auto_heal:  │          98%         │  │
│  │          │  │-    tion: true, │+    true,        │                      │  │
│  │          │  │     ai_stream-  │     visual_diff:│ Security ██████░░░░  │  │
│  │          │  │     ing: true,  │+    true,        │          82%         │  │
│  │          │  │   },            │     ai_stream-  │                      │  │
│  │          │  │   styles: {     │     ing: true,  │                      │  │
│  │          │  │     buttons: {  │   },            │                      │  │
│  │          │  │       radius:   │   styles: {     │                      │  │
│  │          │  │         'sm',   │     buttons: {  │                      │  │
│  │          │  │     }           │       radius:   │                      │  │
│  │          │  │   }             │         'sm',   │                      │  │
│  │          │  │ });             │     }           │                      │  │
│  │          │  │                 │   }             │                      │  │
│  │          │  │                 │ });             │                      │  │
│  │          │  │                 │                 │                      │  │
│  └──────────┘  └────────────────────────────────────────────────────────┘  │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │ ORCHESTRATION                                            [👤] [⚡] [📊]│
│  ├─────────────────────────────────────────────────────────────────────┤   │
│  │ Active Session: draftframe-editor                         [● ACTIVE]│   │
│  │ 14m  │  💾 1.4GB                                                     │   │
│  ├─────────────────────────────────────────────────────────────────────┤   │
│  │ PENDING TASKS                                                       │   │
│  │ ○ Review config diff                                                │   │
│  │ ☐ Commit style updates                                              │   │
│  ├─────────────────────────────────────────────────────────────────────┤   │
│  │ POPULAR RECIPES                                                     │   │
│  │ ┌──────────┐ ┌──────────┐                                           │   │
│  │ │   ⚡     │ │   🛠     │                                           │   │
│  │ │ Nuxt     │ │ Drizzle  │                                           │   │
│  │ │ Hydrate  │ │ Mig      │                                           │   │
│  │ └──────────┘ └──────────┘                                           │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│  ┌───────────────────────────────────────────────────────────────────────┐ │
│  │ ⚪ Pi generated a diff for action.config.ts              [DISMISS]    │ │
│  └───────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
```
### Component Details
**Diff Viewer**
```
Layout: 3-column split
- Column 1 (Original): 35%, background subtle red tint
- Column 2 (Modified): 35%, background subtle green tint  
- Column 3 (Thought): 30%, background #13131f
Line numbers: 40px width, text-tertiary
Gutter: 20px, shows +/- indicators
Removed lines: Background rgba(239, 68, 68, 0.1)
Added lines: Background rgba(34, 197, 94, 0.1)
```
**Thought Panel - Plan Section**
```
Numbered list with accent-primary numbers
Font: 12px
Spacing: 8px between items
```
**Thought Panel - Confidence Bars**
```
Label: 12px text-secondary
Bar: 4px height, full width
Fill: gradient based on percentage
Value: 12px mono right-aligned
```
**Notification Toast**
```
Position: fixed, bottom 24px, center
Background: #1a1a2e
Border: 1px solid #2a2a3e
Border-radius: 8px
Padding: 12px 16px
Shadow: 0 4px 20px rgba(0,0,0,0.5)
Animation: slide up 200ms
```
---
## Screen 5: Recipe Creation Modal
### Layout
```
┌─────────────────────────────────────────────────────────────────────────────┐
│ [C] CleoOS        Editor   Terminal  Live Preview  Logs        [🔍] [👤]  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│                                    ...                                      │
│                                                                             │
│       ┌─────────────────────────────────────────────────────────────────┐   │
│       │                                                                 │   │
│       │  Save as Recipe                                                 │   │
│       │  SYNTHETIC ORCHESTRATION                                        │   │
│       │                                                                 │   │
│       │  ┌───────────────────────────────────┬────────────────────────┐ │   │
│       │  │                                   │   CARD PREVIEW         │ │   │
│       │  │  RECIPE IDENTITY                  │   ┌────────────────┐   │ │   │
│       │  │                                   │   │ [🐛]     AI READY│   │ │   │
│       │  │  Name                             │   │                │   │ │   │
│       │  │  ┌─────────────────────────────┐  │   │ Create Bug     │   │ │   │
│       │  │  │ Create Bug                  │  │   │                │   │ │   │
│       │  │  └─────────────────────────────┘  │   │ Automates the  │   │ │   │
│       │  │                                   │   │ capture of...  │   │ │   │
│       │  │  EXECUTION LOGIC                  │   └────────────────┘   │ │   │
│       │  │                                   │                        │ │   │
│       │  │  Description                      │   TEMPLATES            │ │   │
│       │  │  ┌─────────────────────────────┐  │   ┌────────────────┐   │ │   │
│       │  │  │ Automates the capture of    │  │   │ Create PR    + │   │ │   │
│       │  │  │ stack traces, logs, and     │  │   ├────────────────┤   │ │   │
│       │  │  │ creates a formatted Jira    │  │   │ Commit & Push+ │   │ │   │
│       │  │  │ ticket with high-priority   │  │   ├────────────────┤   │ │   │
│       │  │  │ labels.                     │  │   │ Red Team     + │   │ │   │
│       │  │  └─────────────────────────────┘  │   ├────────────────┤   │ │   │
│       │  │                                   │   │ Pen Test     + │   │ │   │
│       │  │  VISUAL ANCHOR                    │   └────────────────┘   │ │   │
│       │  │                                   │                        │ │   │
│       │  │  [▶] [🔀] [🐛] [🛡] [🔒] [⚡]       │                        │ │   │
│       │  │   ◄──── Selected: Bug icon        │                        │ │   │
│       │  │                                   │                        │ │   │
│       │  ├───────────────────────────────────┴────────────────────────┤ │   │
│       │  │                                                           │ │   │
│       │  │  [  DISCARD  ]  [    PERSIST RECIPE    ]                  │ │   │
│       │  │                                                           │ │   │
│       │  └───────────────────────────────────────────────────────────┘ │   │
│       │                                                                 │   │
│       └─────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│                                    ...                                      │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```
### Component Details
**Modal Container**
```
Width: 800px max, 90vw
Background: #13131f
Border: 1px solid #2a2a3e
Border-radius: 12px
Shadow: 0 25px 50px rgba(0,0,0,0.7)
Padding: 24px
```
**Form Input**
```
Background: #0a0a0f
Border: 1px solid #2a2a3e
Border-radius: 6px
Padding: 10px 12px
Font: 14px
Focus: border #a855f7, glow
```
**Icon Selector**
```
Size: 40px × 40px per icon
Background: transparent
Border: 2px solid transparent
Border-radius: 8px
Selected: background #1a1a2e, border #a855f7
Hover: background #1a1a2e
```
**Card Preview**
```
Background: #0a0a0f
Border: 1px solid #2a2a3e
Border-radius: 8px
Padding: 16px
```
**Template List Item**
```
Height: 44px
Background: transparent
Hover: background #1a1a2e
Border-bottom: 1px solid #2a2a3e
Plus button: right-aligned, accent color
```
---
## Screen 6: Live Preview with DevTools
### Layout
```
┌─────────────────────────────────────────────────────────────────────────────┐
│ [C] CleoOS        Editor   Terminal  [Live Preview]  Logs      [🔍] [👤]  │
├─────────────────────────────────────────────────────────────────────────────┤
│  ┌──────────┐  ┌────────────────────────────────────────────────────────┐  │
│  │          │  │ BROWSER VIEWPORT          [60 FPS]              [⟳] [⛶]│  │
│  │ EXPLORER │  ├────────────────────────────────────────────────────────┤  │
│  │          │  │ ┌────────────────────────────────────────────────────┐ │  │
│  │ 📁 src   │  │ │  🟪 SyntheticStore                                 │ │  │
│  │   📄 App │  │ │                                                    │ │  │
│  │   📄 ind │  │ │  Explore  Inventory  Orders              [👤]      │ │  │
│  │          │  │ │                                                    │ │  │
│  │          │  │ │  Inventory Management                              │ │  │
│  │          │  │ │                                                    │ │  │
│  │          │  │ │  ┌──────────┐  ┌──────────┐  ┌──────────────────┐  │ │  │
│  │          │  │ │  │ [watch]  │  │ [headph] │  │ [sunglasses]     │  │ │  │
│  │          │  │ │  │          │  │          │  │    ┌─────────┐   │  │ │  │
│  │          │  │ │  │          │  │          │  │    │selected │   │  │ │  │
│  │          │  │ │  │          │  │          │  │    └─────────┘   │  │ │  │
│  │          │  │ │  │          │  │          │  │  purple border   │  │ │  │
│  │          │  │ │  └──────────┘  └──────────┘  └──────────────────┘  │ │  │
│  │          │  │ │                                                    │ │  │
│  │          │  │ └────────────────────────────────────────────────────┘ │  │
│  ├──────────┤  ├────────────────────────────────────────────────────────┤  │
│  │ 🌿 main ▼│  │ ≡ DOM TREE │ Elements │ Styles │ Computed │ Event List│  │
│  └──────────┘  ├────────────────────────────────────────────────────────┤  │
│                │ <html lang="en">                                       │  │
│  ┌───────────┐ │   <head>...</head>                                     │  │
│  │           │ │   <body class="bg-white">                              │  │
│  │ ORCHESTRA │ │     <header>...</header>                               │  │
│  │           │ │     <main>                                             │  │
│  │ Agents    │ │       <h1>Inventory Management</h1>                    │  │
│  │ Recipes   │ │       <div class="grid grid-cols-3">                   │  │
│  │ Tasks     │ │         <div class="card">...</div>                    │  │
│  │           │ │         <div class="card">...</div>                    │  │
│  │ SELECTED  │ │         ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓│  │
│  │ PROPERTIES│ │         highlighted element in DOM tree               │  │
│  │           │ │       </div>                                           │  │
│  │ display   │ │     </main>                                            │  │
│  │ flex      │ │   </body>                                              │  │
│  │           │ │ </html>                                                │  │
│  └───────────┘ │                                                        │  │
│                │ html > body > main > div.grid > div.card.active         │  │
│  ┌───────────┐ ├────────────────────────────────────────────────────────┤  │
│  │ CLEO      │ │ ▣ Console │ draftframe-live-support │ 🕐 History        │  │
│  │ INSIGHTS  │ └────────────────────────────────────────────────────────┘  │
│  │           │                                                             │
│  │ ✨ Detected│  ┌─────────────────────────────────────────────────────┐   │
│  │ high CLS  │  │  🟢 Live Session Active    NODE v18.12.0  [DEV ▼]   │   │
│  │ risk on   │  └─────────────────────────────────────────────────────┘   │
│  │ item      │                                                             │
│  │ trans...  │                                                             │
│  │           │                                                             │
│  │ [FIX      │                                                             │
│  │ AUTOMA...]│                                                             │
│  ├───────────┤                                                             │
│  │ METRICS   │                                                             │
│  │           │                                                             │
│  │ 1.2S 0.02 │                                                             │
│  │ LCP   CLS │                                                             │
│  └───────────┘                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```
### Component Details
**Browser Preview Frame**
```
Background: white (for web content)
Border: 1px solid #2a2a3e
Border-radius: 8px
Padding: 0 (edge-to-edge content)
Overflow: hidden
```
**Selected Element Overlay**
```
Border: 2px solid #a855f7
Background: rgba(168, 85, 247, 0.1)
Box-shadow: 0 0 0 4px rgba(168, 85, 247, 0.2)
Label: Position absolute, top -24px
  Background: #a855f7
  Color: white
  Padding: 2px 8px
  Border-radius: 4px
  Font: 11px mono
```
**DevTools Panel**
```
Height: 300px (resizable)
Background: #13131f
Border-top: 1px solid #2a2a3e
Tabs: padding 12px 16px
Active tab: border-bottom 2px accent-primary
```
**DOM Tree Node**
```
Padding: 4px 8px 4px (16px × depth)
Hover: background #1a1a2e
Selected: background rgba(168, 85, 247, 0.2)
Expand icon: 12px, text-tertiary
Tag: color #f472b6 (pink)
Attribute: color #a5b4fc (indigo)
```
**Breadcrumb Path**
```
Height: 28px
Background: #0a0a0f
Border-top: 1px solid #2a2a3e
Font: 12px mono
Color: text-secondary
Separator: > symbol
Hover: text-primary
```
**Cleo Insights Card**
```
Background: rgba(168, 85, 247, 0.1)
Border: 1px solid #a855f7
Border-radius: 8px
Padding: 12px
Icon: 16px, accent-primary
```
**Metrics Box**
```
Background: #1a1a2e
Border-radius: 6px
Padding: 12px
Value: 18px mono bold
Label: 10px uppercase
```
---
## Component Behavior Specifications
### Panel Resizing
```
┌─────────────────────────────────────────────────────────────────┐
│  Resize Handle Specifications                                   │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Left Panel Resize:                                             │
│  ┌────────────────┬───────────────────────────────────────────┐ │
│  │                ││                                          │ │
│  │   PANEL        ││  MAIN CONTENT                            │ │
│  │                ││                                          │ │
│  │   (240px)      ││                                          │ │
│  │                ││                                          │ │
│  └────────────────┴───────────────────────────────────────────┘ │
│                   ↑                                             │
│                   Hit area: 8px                                 │
│                   Cursor: ew-resize                             │
│                   Min: 200px, Max: 400px                        │
│                                                                 │
│  Bottom Panel Resize:                                           │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                                                           │  │
│  │                    MAIN CONTENT                           │  │
│  │                                                           │  │
│  ├───────────────────────────────────────────────────────────┤  │
│  │ ↑                                                         │  │
│  │ Hit area: 8px                                             │  │
│  │ Cursor: ns-resize                                         │  │
│  │ Min: 100px, Max: 600px                                    │  │
│  │                  BOTTOM PANEL                             │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```
### Collapse/Expand Animations
| Action | Duration | Easing | Transform |
|--------|----------|--------|-----------|
| Panel collapse | 200ms | cubic-bezier(0.4, 0, 0.2, 1) | width 240px → 0 |
| Panel expand | 200ms | cubic-bezier(0.4, 0, 0.2, 1) | width 0 → 240px |
| Bottom panel | 250ms | cubic-bezier(0.4, 0, 0.2, 1) | height 200px → 0 |
| Modal open | 150ms | cubic-bezier(0, 0, 0.2, 1) | scale 0.95 → 1, opacity 0 → 1 |
| Modal close | 100ms | ease-in | opacity 1 → 0 |
### Tab Switching
```
Active Tab Indicator:
┌─────────────────────────────────────┐
│  Tab 1  │  Tab 2  │  [Tab 3]  │  +  │
│         │         │   ────    │     │
└─────────────────────────────────────┘
Indicator: 2px solid accent-primary
Animation: slide 150ms ease
```
---
## Responsive Breakpoints
### Desktop XL (≥1600px)
```
Layout: Full 3-panel
Left: 240px fixed
Right: 300px fixed  
Center: flex 1
Bottom: 200px
```
### Desktop (1200-1599px)
```
Layout: 3-panel with smaller right
Left: 220px fixed
Right: 280px fixed
Center: flex 1
Bottom: 180px
```
### Laptop (992-1199px)
```
Layout: Collapsible right panel
Left: 200px fixed
Right: 0 (collapsed, overlay when open)
Center: flex 1
Bottom: 160px
Right panel opens as overlay:
┌───────────────────────────────────┐
│  Main Content    │  [Overlay]    │
│                  │  Right Panel  │
│                  │  (300px)      │
│                  │               │
└───────────────────────────────────┘
Background dim: rgba(0,0,0,0.5)
```
### Tablet (768-991px)
```
Layout: Left as overlay
Left: 0 (collapsed, overlay when open)
Right: 0 (collapsed)
Center: 100%
Bottom: 140px
Both panels open as full overlays
```
---
## Accessibility Specifications
### Keyboard Navigation
```
Tab Order:
1. Top navigation items
2. Left panel toggle
3. Left panel content
4. Center workspace
5. Right panel toggle  
6. Bottom panel toggle
7. Command palette (Cmd/Ctrl+Shift+P)
Panel Focus:
- Arrow keys navigate within panels
- Enter activates items
- Escape closes overlays/modals
- Cmd/Ctrl+number switches tabs
```
### Screen Reader
```
Landmarks:
- role="navigation" (top bar)
- role="complementary" (left/right panels)
- role="main" (center workspace)
- role="contentinfo" (bottom terminal)
Live Regions:
- aria-live="polite" for AI responses
- aria-live="assertive" for errors
- aria-live="polite" for status updates
Focus Indicators:
- Outline: 2px solid accent-primary
- Offset: 2px
- Always visible
```
### Color Contrast
```
All text meets WCAG AA:
- Large text (18px+): 3:1 minimum
- Normal text: 4.5:1 minimum
Interactive elements:
- Focus states: 3:1 against background
- Disabled states: still visible (not 0 opacity)
```
---
## Implementation Checklist
### Phase 1: Foundation
- [ ] CSS custom properties (tokens.css)
- [ ] Base component library
- [ ] Layout shell (3-panel structure)
- [ ] Panel resize handlers
- [ ] Keyboard navigation
### Phase 2: Core Features
- [ ] File explorer tree
- [ ] Code editor integration
- [ ] Terminal (xterm.js)
- [ ] Tab system
- [ ] Git integration
### Phase 3: AI Features
- [ ] AI Terminal component
- [ ] Message streaming UI
- [ ] Diff viewer
- [ ] Session cards
- [ ] Recipe grid
### Phase 4: Advanced
- [ ] Live preview
- [ ] DevTools panel
- [ ] Recipe editor modal
- [ ] Resource monitors
- [ ] Keyboard shortcuts
### Phase 5: Polish
- [ ] Animations
- [ ] Accessibility audit
- [ ] Performance optimization
- [ ] Responsive testing
- [ ] Theme system
---
## Integration with Pi Harness
### Harness API Surface
```typescript
// PiHarness UI interface
interface PiHarnessUI {
  // Session Management
  listSessions(): Promise<Session[]>;
  createSession(options: SessionOptions): Promise<Session>;
  terminateSession(sessionId: string): Promise<void>;
  
  // Extension Management
  installExtension(scope: Scope, extension: Extension): Promise<void>;
  removeExtension(scope: Scope, name: string): Promise<void>;
  listExtensions(scope: Scope): Promise<Extension[]>;
  
  // Instructions
  injectInstructions(scope: Scope, instructions: string): Promise<void>;
  removeInstructions(scope: Scope, id: string): Promise<void>;
  
  // Themes
  installTheme(theme: Theme): Promise<void>;
  setActiveTheme(themeId: string): Promise<void>;
  listThemes(): Promise<Theme[]>;
  
  // Streaming
  onStream(callback: (event: StreamEvent) => void): void;
  sendMessage(sessionId: string, message: string): Promise<void>;
}
```
### UI State Sync
```
Pi Harness Event → UI Update
─────────────────────────────────────
Session created   → Add session card
Session updated   → Update status/badge
Session completed → Move to history
Stream chunk      → Append to terminal
Extension loaded  → Add to recipe grid
Theme changed     → Apply CSS variables
```
---
## Summary
These wireframes provide exact specifications for implementing the CleoOS Pi Code Agent harness interface. Key principles:
1. **Information density** without clutter
2. **Context awareness** - AI and code side by side
3. **Extensibility** - Plugin-ready architecture
4. **Lore integration** - Circle of Eleven as UI roles
5. **Pi harness native** - First-class integration
The Hearth becomes the workshop surface where the Circle of Eleven aspects (domains) manifest as functional UI elements, creating a cohesive AI-first development environment.
