<!-- Merged from the ct-stickynote skill into ct-cleo (T12649, D11157). -->

# Sticky notes — capture before you classify

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
| `sticky.convert` | Promote to task/memory | `cleo sticky convert SN-001 --to-task --title "..."` or `--to-memory --type learning` |
| `sticky.archive` | Archive | `cleo sticky archive SN-001` |


Also: `cleo sticky jot "..."` (alias of add), `cleo sticky ls`, and
`cleo sticky purge <id>` (permanent). Sticky notes are a core CLEO feature, so
this guide ships inside ct-cleo rather than as a separate skill.
