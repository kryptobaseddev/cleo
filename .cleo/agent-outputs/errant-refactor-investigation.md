# T1757 — Errant Nested Directories Investigation

**Date**: 2026-05-04  
**Task**: T1757 (epic)  
**Status**: Complete — owner approval required before any destructive action

---

## Executive Summary

Two anomalous untracked directory structures were investigated. They are distinct in nature and require different remediation:

| Directory | Classification | Action Required |
|-----------|---------------|-----------------|
| `packages/core/packages/core/` | Errant — stale agent working-copy artifact | Delete (backup first) |
| `packages/skills/skills/ct-council/` | Legitimate — skill never committed to git | Commit to git |

---

## 1. Inventory Tables

### 1a. `packages/core/packages/core/` (Suspect 1)

| File | Size (bytes) | Language | Status |
|------|-------------|----------|--------|
| `src/lib/suppress-sqlite-warning.ts` | 1,313 | TypeScript | Errant copy of proper file |
| `src/lib/__tests__/suppress-sqlite-warning.test.ts` | 2,674 | TypeScript | Errant copy with extra comments |

**Total**: 2 files, ~4 KB, untracked in git.

Proper counterparts exist at:
- `packages/core/src/lib/suppress-sqlite-warning.ts` (1,299 bytes)
- `packages/core/src/lib/__tests__/suppress-sqlite-warning.test.ts` (2,310 bytes)

### 1b. `packages/skills/skills/ct-council/` (Suspect 2)

| Category | Count | Lines |
|----------|-------|-------|
| Python scripts (`.py`) | 9 | 3,761 total |
| Markdown documents (`.md`) | 116 | 7,174 total |
| JSON files (`.json`) | 14 | 322 total |
| Other (`.pyc`, `.yaml`, `.gitignore`, `.json`) | 16 | — |
| **Total** | **155** | — |

**Total directory size**: 1.7 MB (includes `.runs/` with 6 council run archives)

**Top-level layout**:
```
ct-council/
├── SKILL.md                    # 23,685 bytes — core skill definition
├── .gitignore                  # excludes .runs/, .cleo/, campaigns/, .active-campaign
├── references/                 # 8 advisor/protocol MD files (committed content)
├── scripts/                    # 9 Python scripts including run_council.py, validate.py
├── optimization/               # hardening playbook + campaign manager
│   ├── HARDENING-PLAYBOOK.md   # committed content
│   ├── README.md               # committed content
│   ├── scenarios.yaml          # committed content
│   └── scripts/campaign.py    # committed content
├── .runs/                      # 6 timestamped council run archives (gitignored)
└── .cleo/                      # runtime state: council-runs.jsonl (gitignored)
```

---

## 2. Provenance Evidence

### 2a. `packages/core/packages/core/` — Errant Agent Working-Copy

**Key timestamps**:
- Errant `suppress-sqlite-warning.ts` mtime: **2026-04-28 19:42:42**
- Proper `suppress-sqlite-warning.ts` mtime: **2026-04-24 21:09:01**
- Original commit (T1406): **2026-04-24 17:03:26** (commit `a70d371e5`)

**Provenance conclusion**: The original T1406 commit created the files correctly at `packages/core/src/lib/`. Four days later (2026-04-28), an agent created an errant copy at `packages/core/packages/core/src/lib/`. The errant copy has **slightly different content** — the diff shows the errant version uses the older style `message && message.includes(...)` instead of optional chaining `message?.includes(...)`, and the test file contains extra descriptive comments (`// Arrange:`, `// Act:`, `// Assert:`, `// Cleanup:`) that were removed in the canonical version.

**Root cause**: An agent working inside a `packages/core/`-rooted worktree or shell context misread its CWD as the monorepo root, then executed `write packages/core/src/lib/...` which resolved to `packages/core/packages/core/src/lib/...` from its perspective.

**Git status**: Fully untracked — zero git history. No commits reference this path.

### 2b. `packages/skills/skills/ct-council/` — Legitimate Skill, Never Committed

**Key timestamps**:
- `.runs/` oldest entry: **20260425T023423Z** (2026-04-25 02:34)
- `SKILL.md` mtime: **2026-04-24 23:08**
- `.cleo/.context-state.json` timestamp: `2026-04-25T04:09:13Z`

**Context state evidence**:
```json
{
  "workspace": "/mnt/projects/cleocode/packages/skills/skills/ct-council/scripts"
}
```

**Provenance conclusion**: The ct-council skill was created on 2026-04-24 (same day as T1406) by an agent running from the correct workspace path. The agent created the full skill structure correctly. The `.gitignore` inside ct-council deliberately excludes runtime artifacts (`.runs/`, `.cleo/`, `optimization/campaigns/`). The SKILL.md, references/, scripts/, and optimization/ durable files were intended to be committed but never were.

**Comparison to peer skills**: Every other skill in `packages/skills/skills/` is tracked in git (verified via `git ls-files`). `ct-council` is the sole exception.

---

## 3. Workspace Impact Assessment

### pnpm Phantom Workspace Risk

**`pnpm-workspace.yaml` glob**: `packages/*`

This glob matches only **direct children** of `packages/` — specifically:
- `packages/core/` (direct child, has `package.json`)
- `packages/skills/` (direct child, has `package.json`)

The errant nested directory `packages/core/packages/core/` has **no `package.json`** — confirmed by `find /mnt/projects/cleocode/packages/core/packages -name "package.json"` returning empty. Therefore:

- **No phantom workspace** is created by the errant nested `packages/core/packages/core/`
- `pnpm list --recursive --depth 0` shows only `@cleocode/core@2026.5.16` once, at the proper path
- No duplicate package resolution risk exists

**Assessment**: No active pnpm/build impact from the errant core files. The `packages/core/packages/` subtree is invisible to pnpm's workspace resolver.

---

## 4. Per-File Classification

### 4a. `packages/core/packages/core/` files

| File | Classification | Rationale |
|------|---------------|-----------|
| `src/lib/suppress-sqlite-warning.ts` | **Errant — delete** | Stale copy of canonical file at `packages/core/src/lib/suppress-sqlite-warning.ts`. Errant copy has older implementation style (pre-optional-chaining refactor). Canonical version is live and committed. |
| `src/lib/__tests__/suppress-sqlite-warning.test.ts` | **Errant — delete** | Stale copy with extra scaffolding comments stripped in canonical version. Canonical version is live and committed. |

### 4b. `packages/skills/skills/ct-council/` files

| Path | Classification | Rationale |
|------|---------------|-----------|
| `SKILL.md` | **Legitimate — commit** | Core skill definition. All peer skills have SKILL.md tracked. |
| `references/*.md` (8 files) | **Legitimate — commit** | Advisor persona files referenced by SKILL.md. Should be committed per pattern of all other skills. |
| `scripts/*.py` (9 files) | **Legitimate — commit** | `run_council.py`, `validate.py`, `telemetry.py`, `analyze_runs.py`, etc. These are the runtime scripts that execute the council workflow. |
| `optimization/HARDENING-PLAYBOOK.md` | **Legitimate — commit** | Durable playbook template. optimization/README.md explicitly states this is committed content. |
| `optimization/README.md` | **Legitimate — commit** | As above. |
| `optimization/scenarios.yaml` | **Legitimate — commit** | As above. |
| `optimization/scripts/campaign.py` | **Legitimate — commit** | As above. |
| `optimization/scripts/test_campaign.py` | **Legitimate — commit** | Test for campaign.py. |
| `.gitignore` | **Legitimate — commit** | Defines what to exclude. Should be tracked. |
| `.runs/` (6 run archives, ~70 files) | **Legitimate — gitignore** | Already gitignored by `ct-council/.gitignore`. Runtime artifacts. No action needed. |
| `.cleo/council-runs.jsonl` | **Legitimate — gitignore** | Already gitignored. Runtime telemetry. |
| `optimization/campaigns/` | **Legitimate — gitignore** | Already gitignored per `optimization/.gitignore`. Per-campaign state. |
| `optimization/.active-campaign` | **Legitimate — gitignore** | Already gitignored. |
| `optimization/scripts/__pycache__/` | **Errant — gitignore** | Python bytecode cache. Already covered by `*.pyc` in `.gitignore`. |

---

## 5. Cleanup Script (Pending Owner Approval — DO NOT EXECUTE)

The following script is staged for review. It must NOT be executed without explicit owner approval.

**Saved at**: `/mnt/projects/cleocode/.cleo/agent-outputs/errant-refactor-cleanup.sh`

Contents:
```bash
#!/usr/bin/env bash
# T1757 Cleanup Script — REQUIRES OWNER APPROVAL before execution
# Generated: 2026-05-04

set -euo pipefail

REPO_ROOT="/mnt/projects/cleocode"
BACKUP_DIR="$REPO_ROOT/.cleo/backups"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)

echo "=== T1757 Cleanup Script ==="
echo "Timestamp: $TIMESTAMP"

# ============================================================
# ACTION 1: Backup + delete errant packages/core/packages/core/
# ============================================================
echo ""
echo "--- ACTION 1: Backup errant packages/core/packages/core/ ---"
mkdir -p "$BACKUP_DIR"
tar czf "$BACKUP_DIR/errant-core-nested-$TIMESTAMP.tar.gz" \
    -C "$REPO_ROOT" \
    packages/core/packages/
echo "Backup written: $BACKUP_DIR/errant-core-nested-$TIMESTAMP.tar.gz"
rm -rf "$REPO_ROOT/packages/core/packages/"
echo "Deleted: packages/core/packages/"

# ============================================================
# ACTION 2: Commit ct-council skill to git
# ============================================================
echo ""
echo "--- ACTION 2: Commit ct-council skill files to git ---"
cd "$REPO_ROOT"

# Stage only committed-content files (respecting .gitignore)
git add \
    packages/skills/skills/ct-council/.gitignore \
    packages/skills/skills/ct-council/SKILL.md \
    packages/skills/skills/ct-council/references/ \
    packages/skills/skills/ct-council/scripts/ \
    packages/skills/skills/ct-council/optimization/HARDENING-PLAYBOOK.md \
    packages/skills/skills/ct-council/optimization/README.md \
    packages/skills/skills/ct-council/optimization/scenarios.yaml \
    packages/skills/skills/ct-council/optimization/scripts/campaign.py \
    packages/skills/skills/ct-council/optimization/scripts/test_campaign.py \
    packages/skills/skills/ct-council/optimization/.gitignore

git commit -m "feat(skills/ct-council): add ct-council skill — council review workflow

The Council skill was created 2026-04-24 during the T1406 session
but was never committed. Discovered untracked during T1757 investigation.

Adds 5-advisor peer-review Council workflow with:
- SKILL.md (23KB) — full skill specification
- references/ — 8 advisor persona files (contrarian, executor, etc.)
- scripts/ — Python runtime (run_council.py, validate.py, telemetry.py, etc.)
- optimization/ — hardening playbook + campaign manager scripts

Runtime artifacts (.runs/, .cleo/, campaigns/) excluded via .gitignore.

Closes T1757 cleanup phase 1 (commit missing skill)"

echo "ct-council committed."

# ============================================================
# VERIFICATION
# ============================================================
echo ""
echo "--- VERIFICATION ---"
echo "Checking errant dir is gone:"
ls "$REPO_ROOT/packages/core/packages/" 2>/dev/null && echo "FAIL: still exists" || echo "OK: removed"
echo "Checking ct-council is tracked:"
git ls-files packages/skills/skills/ct-council/SKILL.md | grep -q SKILL.md && echo "OK: tracked" || echo "FAIL: not tracked"
echo "pnpm workspace check:"
pnpm list --recursive --depth 0 2>&1 | grep -c "@cleocode/core"
echo "Expected: 1 (no phantom)"

echo ""
echo "=== Cleanup complete ==="
```

---

## 6. Follow-Up Tasks (via `cleo add --parent T1757`)

The following implementation tasks should be filed:

| Task | Description | Priority |
|------|-------------|----------|
| T1757-A | Execute cleanup script: delete `packages/core/packages/core/` after backup | High |
| T1757-B | Commit `packages/skills/skills/ct-council/` skill files to git | High |
| T1757-C | Add ct-council to `packages/skills/skills.json` manifest registry | Medium |
| T1757-D | Investigate why the errant `packages/core/packages/core/` files were created (worktree CWD discipline audit) | Low |

---

## Appendix: Key Evidence

**Errant core directory git status**:
```
?? packages/core/packages/
```

**Errant core file diff excerpt** (errant vs canonical):
```diff
26,28c26,27
<   const message =
<     typeof warning === 'string' ? warning : (warning as Error | undefined)?.message;
<   if (message && message.includes(SQLITE_EXPERIMENTAL_MSG)) {
---
>   const message = typeof warning === 'string' ? warning : (warning as Error | undefined)?.message;
>   if (message?.includes(SQLITE_EXPERIMENTAL_MSG)) {
```

**pnpm workspace glob**: `packages/*` — does not match nested `packages/core/packages/core/` (no `package.json` there either).

**ct-council context state** (evidence agent was operating in correct location):
```json
{ "workspace": "/mnt/projects/cleocode/packages/skills/skills/ct-council/scripts" }
```

**Peer skill pattern**: All 28 other skill directories under `packages/skills/skills/` have SKILL.md tracked in git. `ct-council` is the sole untracked skill.
