---
name: ct-stickynote
description: Quick ephemeral sticky notes for project-wide capture before formal classification
version: 1.0.0
category: productivity
tier: 0
protocol: null
tags: [sticky, notes, capture, quick, ephemeral]
triggers: [note, sticky, jot, capture]
compatibility: [claude-code, gemini-cli, codex-cli, opencode]
dependencies: []
sharedResources: []
license: MIT
---

# Sticky Notes Skill

Quick capture ephemeral notes that fill the gap between session notes and formal tasks.

## When to Use

Use sticky notes for:
- Quick thoughts that don't fit a formal task yet
- Temporary reminders
- Ideas that need refinement before becoming tasks
- Notes that span multiple sessions

## Operations

| Operation | Usage | Example |
|-----------|-------|---------|
| `sticky.add` | Create sticky | `cleo sticky add "Refactor auth middleware" --tag bug --color red` |
| `sticky.list` | List active | `cleo sticky list --tag bug` |
| `sticky.show` | Show details | `cleo sticky show SN-001` |
| `sticky.convert` | Promote to task/memory | `cleo sticky convert SN-001 --to-task` |
| `sticky.archive` | Archive | `cleo sticky archive SN-001` |

## Installation

```bash
cleo skill install library:ct-stickynote
```

## Auto-Archive

Stickies auto-archive after 30 days if not converted.
