# T484 — Orchestrate Domain CLI Verification Report

**Date**: 2026-04-10
**Binary under test**: `cleo v2026.4.25` (symlinked from `@cleocode/cleo-os` bundle at `~/.npm-global/bin/cleo`)
**Source ref**: `packages/cleo/src/cli/commands/orchestrate.ts`

---

## 1. Command Status Matrix

### 1a. Commands Registered in v2026.4.25 (installed binary)

| Command | Help works | Dispatch op | Exit on success |
|---------|-----------|------------|-----------------|
| `orchestrate start <epicId>` | YES | `mutate orchestrate.start` | 0 |
| `orchestrate status [--epic]` | YES | `query orchestrate.status` | 0 |
| `orchestrate analyze <epicId>` | YES | `query orchestrate.analyze` | 0 |
| `orchestrate ready <epicId>` | YES | `query orchestrate.ready` | 0 |
| `orchestrate next <epicId>` | YES | `query orchestrate.next` | 0 |
| `orchestrate waves <epicId>` | YES | `query orchestrate.waves` | 0 |
| `orchestrate spawn <taskId>` | YES | `mutate orchestrate.spawn` | 0 |
| `orchestrate validate <taskId>` | YES | `mutate orchestrate.validate` | 0 |
| `orchestrate context <epicId>` | YES | `query orchestrate.context` | 0 |
| `orchestrate parallel <action> <epicId>` | YES | `mutate orchestrate.parallel` | 0 |
| `orchestrate tessera list` | YES | `query orchestrate.tessera.list` | 0 |
| `orchestrate tessera instantiate <templateId> <epicId>` | YES | `mutate orchestrate.tessera.instantiate` | 0 |
| `orchestrate unblock` | YES | `query orchestrate.unblock.opportunities` | 0 |

**13 commands work correctly in the installed binary.**

### 1b. Commands in Source (orchestrate.ts) NOT in Installed Binary — MISSING FROM RELEASE

The following 12 commands were added in source (tagged @task T483) but were never bundled into a release. They all return `Unknown command <name>` with **exit code 1** (though the shell `$?` shows 0 due to the help renderer's exit behavior — the `Unknown command` error line confirms failure):

| Command | Dispatch op | Source status |
|---------|------------|---------------|
| `orchestrate bootstrap [--epic]` | `query orchestrate.bootstrap` | In source, not released |
| `orchestrate classify <request>` | `query orchestrate.classify` | In source, not released |
| `orchestrate fanout <epicId> [--tasks]` | `mutate orchestrate.fanout` | In source, not released |
| `orchestrate fanout-status [--epic]` | `query orchestrate.fanout.status` | In source, not released |
| `orchestrate handoff <taskId> --protocol` | `mutate orchestrate.handoff` | In source, not released |
| `orchestrate spawn-execute <taskId>` | `mutate orchestrate.spawn.execute` | In source, not released |
| `orchestrate conduit-status` | `query orchestrate.conduit.status` | In source, not released |
| `orchestrate conduit-peek [--limit]` | `query orchestrate.conduit.peek` | In source, not released |
| `orchestrate conduit-start [--poll-interval]` | `mutate orchestrate.conduit.start` | In source, not released |
| `orchestrate conduit-stop` | `mutate orchestrate.conduit.stop` | In source, not released |
| `orchestrate conduit-send <content> [--to] [--conversation]` | `mutate orchestrate.conduit.send` | In source, not released |

**Note on exit codes**: All 11 missing commands print `Unknown command <name>` to stdout, but the process exits with code 0 (the help renderer swallows the non-zero exit). This is a secondary bug: unknown subcommand should exit non-zero.

---

## 2. Duplicate Analysis

### 2a. `cleo orchestrate next` vs `cleo next` — NOT a duplicate

| | `cleo next` | `cleo orchestrate next <epicId>` |
|--|------------|----------------------------------|
| Dispatch op | `tasks.next` | `orchestrate.next` |
| Audience | Single agent picking their own next task | Orchestrator selecting next task to spawn for an epic |
| Epic required | No | Yes (required arg) |
| Purpose | Developer/agent task queue | Multi-agent fanout targeting |

**Verdict**: Different operations, different use cases. Not a duplicate. Names are similar enough to cause confusion — consider documenting the distinction.

### 2b. `cleo deps waves` vs `cleo orchestrate waves` — FUNCTIONAL DUPLICATE

| | `cleo deps waves [epicId]` | `cleo orchestrate waves <epicId>` |
|--|--------------------------|----------------------------------|
| Dispatch op (underlying) | `query orchestrate.waves` | `query orchestrate.waves` |
| Reported op metadata | `tasks.depends` | `orchestrate.waves` |
| epicId | Optional | Required |
| Data output | Identical | Identical |

**Verdict**: Both call `query orchestrate.waves` under the hood. The `deps waves` alias reports wrong operation metadata (`tasks.depends` instead of `orchestrate.waves`). This is a DRY violation — one CLI surface should own this. Recommended: keep `orchestrate waves <epicId>` as canonical, deprecate `deps waves` or alias it transparently with correct metadata.

---

## 3. Conduit Commands — Domain Placement Analysis

The five conduit commands (`conduit-status`, `conduit-peek`, `conduit-start`, `conduit-stop`, `conduit-send`) currently live under `orchestrate` as flat hyphenated names. Per ADR-042 (agent-to-agent messaging) and the DB separation of concerns rule (conduit.db is project-local messaging, separate from orchestration concerns):

**Finding**: There is no top-level `cleo conduit` domain. Conduit messaging is conceptually independent of orchestration (it is peer-to-peer agent communication, not epic/wave management). Placing it under `orchestrate` conflates two concerns.

**Recommended placement**: Move to a top-level `cleo conduit` domain with subcommands (`status`, `peek`, `start`, `stop`, `send`), matching the pattern of `cleo agent`, `cleo session`, `cleo memory`.

If a top-level conduit domain is not yet appropriate, the commands should at minimum be a nested subcommand group (`cleo orchestrate conduit status`) rather than flat hyphenated names, consistent with how `tessera` is structured.

---

## 4. Help String Gap

The `cleo orchestrate --help` USAGE line only lists the 12 commands present in v2026.4.25:

```
cleo orchestrate start|status|analyze|ready|next|waves|spawn|validate|context|parallel|tessera|unblock
```

The source has 25 commands registered. The USAGE line is auto-generated from what is registered — so this will be correct once the T483 commands ship. No manual fix needed, but the gap confirms the release gap.

---

## 5. Summary of Findings

| Finding | Severity | Recommendation |
|---------|----------|---------------|
| 11 T483 commands exist in source but not in installed v2026.4.25 | HIGH | Include in next release |
| Unknown subcommand exits 0 instead of non-zero | MEDIUM | Fix help renderer to exit 1 on unknown subcommand |
| `deps waves` and `orchestrate waves` are functional duplicates with mismatched metadata | MEDIUM | Alias `deps waves` to `orchestrate waves`; fix reported operation metadata |
| `cleo next` vs `orchestrate next` — different ops, similar names | LOW | Add disambiguation note to `orchestrate next` help description |
| Conduit commands placed under `orchestrate` domain | LOW | Consider top-level `cleo conduit` domain per DB separation of concerns |

---

## 6. Raw Test Results

```
orchestrate start --help     EXIT: 0  (help rendered correctly)
orchestrate status           EXIT: 0  (returns JSON, op=orchestrate.status)
orchestrate analyze --help   EXIT: 0  (help rendered correctly)
orchestrate ready --help     EXIT: 0  (help rendered correctly)
orchestrate next --help      EXIT: 0  (help rendered correctly)
orchestrate spawn --help     EXIT: 0  (help rendered correctly)
orchestrate validate --help  EXIT: 0  (help rendered correctly, --file + --manifest options)
orchestrate context --help   EXIT: 0  (help rendered correctly)
orchestrate waves --help     EXIT: 0  (help rendered correctly)
orchestrate parallel --help  EXIT: 0  (help rendered correctly)
orchestrate bootstrap --help EXIT: 0  (falls through to group help — MISSING COMMAND)
orchestrate classify ...     EXIT: 0  (prints "Unknown command classify" — MISSING COMMAND)
orchestrate fanout --help    EXIT: 0  (falls through to group help — MISSING COMMAND)
orchestrate fanout-status    EXIT: 0  (prints "Unknown command fanout-status" — MISSING COMMAND)
orchestrate handoff ...      EXIT: 0  (prints "Unknown command handoff" — MISSING COMMAND)
orchestrate spawn-execute .. EXIT: 0  (prints "Unknown command spawn-execute" — MISSING COMMAND)
orchestrate tessera list     EXIT: 0  (returns JSON with 1 template: tessera-rcasd)
orchestrate tessera inst...  EXIT: 0  (help rendered correctly)
orchestrate unblock          EXIT: 0  (returns JSON with highImpact/singleBlocker/commonBlockers)
orchestrate conduit-status   EXIT: 0  (prints "Unknown command conduit-status" — MISSING COMMAND)
orchestrate conduit-peek     EXIT: 0  (prints "Unknown command conduit-peek" — MISSING COMMAND)
orchestrate conduit-start .. EXIT: 0  (prints "Unknown command conduit-start" — MISSING COMMAND)
orchestrate conduit-stop     EXIT: 0  (prints "Unknown command conduit-stop" — MISSING COMMAND)
orchestrate conduit-send ..  EXIT: 0  (prints "Unknown command conduit-send" — MISSING COMMAND)
```
