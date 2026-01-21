# Troubleshooting Guide

## ID Integrity Issues

### Common Symptoms

- Error: "Duplicate task ID found"
- Error: "ID collision detected"
- Error: "Task ID already exists in archive"
- Tasks appearing with same ID
- `cleo add` fails with collision error

### Causes

| Scenario | Cause | Likelihood |
|----------|-------|------------|
| Duplicate in archive | Manual JSON editing | Common |
| Same ID in todo + archive | Interrupted archive operation | Rare |
| Sequence counter drift | Direct file edits, restore from backup | Uncommon |
| Multiple duplicates | Data corruption, merge conflicts | Very rare |

### Diagnosis

#### Step 1: Check for duplicates

```bash
cleo validate
```

Look for errors like:
```
[ERROR] Duplicate task IDs found in todo.json: T001
[ERROR] IDs exist in both todo.json and archive: T005
```

#### Step 2: Check sequence status

```bash
cleo sequence check
```

**Exit codes:**
- `0` - Sequence valid
- `22` - Counter drift detected
- `20` - Checksum mismatch
- `4` - Sequence file missing

### Resolution

#### Option 1: Interactive repair (recommended)

```bash
cleo validate --fix-duplicates
```

For each duplicate, choose:
1. **Keep first** - Delete later occurrences
2. **Keep newest** - Keep most recently created
3. **Rename** - Append `-dup-N` suffix
4. **Skip** - Leave unchanged

For cross-file duplicates:
1. **Keep active** - Remove from archive (default)
2. **Keep archived** - Remove from todo.json
3. **Rename archived** - Append `-archived` suffix

#### Option 2: Non-interactive repair

```bash
cleo validate --fix-duplicates --non-interactive
```

Uses defaults:
- Same-file duplicates: keep first occurrence
- Cross-file duplicates: keep active version

#### Option 3: Sequence-only repair

```bash
cleo sequence repair
```

Only fixes sequence counter, doesn't resolve existing duplicates.

### Prevention Best Practices

1. **Never edit JSON files directly** - Use CLI commands only
2. **Don't restore partial backups** - Use `cleo restore` instead
3. **Run validation after migrations** - `cleo validate`
4. **Keep sequence file** - Don't delete `.cleo/.sequence`

### Recovery from Severe Corruption

If multiple issues exist:

```bash
# 1. Create safety backup
cleo backup

# 2. Fix all duplicates
cleo validate --fix-duplicates --non-interactive

# 3. Repair sequence
cleo sequence repair

# 4. Verify clean state
cleo validate
```

### Upgrade/Migration Issues

For projects created before v0.51.1:

```bash
# Bootstrap sequence system
cleo upgrade

# Verify
cleo sequence show
```

## Other Common Issues

### Checksum Mismatch

**Symptom:** `[ERROR] Checksum mismatch`

**Cause:** File modified outside of CLEO

**Fix:**
```bash
cleo validate --fix
```

### Orphaned Tasks

**Symptom:** `[ERROR] Found N orphaned tasks`

**Cause:** Parent task deleted without updating children

**Fix:**
```bash
cleo validate --fix-orphans unlink  # Remove parent reference
# OR
cleo validate --fix-orphans delete  # Delete orphaned tasks
```

### Missing Dependencies

**Symptom:** `[ERROR] Task references missing dependency`

**Cause:** Dependent task deleted or archived

**Fix:** Remove the dependency manually or restore the missing task.

## Debug Environment Variables

### Orchestrator & Skill System Debug

Enable debug output for troubleshooting skill dispatch and orchestration issues:

| Variable | Component | Prefix |
|----------|-----------|--------|
| `SKILL_DISPATCH_DEBUG` | Skill selection & injection | `[skill-dispatch]` |
| `ORCHESTRATOR_SPAWN_DEBUG` | Agent spawning lifecycle | `[orchestrator-spawn]` |
| `SUBAGENT_INJECT_DEBUG` | Prompt template injection | `[subagent-inject]` |
| `CLEO_DEBUG` | General CLI operations | varies |

### Usage

```bash
# Enable skill dispatch debugging
export SKILL_DISPATCH_DEBUG=1
cleo orchestrate --epic T001

# Enable full orchestrator debugging
export SKILL_DISPATCH_DEBUG=1
export ORCHESTRATOR_SPAWN_DEBUG=1
export SUBAGENT_INJECT_DEBUG=1
cleo orchestrate --epic T001

# Disable debugging
unset SKILL_DISPATCH_DEBUG ORCHESTRATOR_SPAWN_DEBUG SUBAGENT_INJECT_DEBUG
```

### Sample Debug Output

```
[skill-dispatch] DEBUG: Selecting skill for type='task', labels=["research"]
[skill-dispatch] DEBUG: Keyword match: 'research' in 'ct-research-agent'
[skill-dispatch] Selected 'ct-research-agent' (reason: keyword match)
[skill-dispatch] DEBUG: Skill 'ct-research-agent' passed validation
```

### Troubleshooting Skill Dispatch

**Symptom:** Wrong skill selected for task

**Debug steps:**
```bash
export SKILL_DISPATCH_DEBUG=1
cleo show T001 --format json | jq '.task.labels, .task.title'
# Check if labels or title keywords match expected skill triggers
```

**Common causes:**
- Task missing labels that match skill dispatch triggers
- Keywords in title not matching skill's keyword triggers
- Skill status not "active" in manifest.json

## Getting Help

If issues persist:

1. Run `cleo validate` and save output
2. Check `cleo log --limit 20` for recent operations
3. Create backup: `cleo backup`
4. Report issue with validation output
