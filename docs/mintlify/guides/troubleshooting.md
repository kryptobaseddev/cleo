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

## Protocol Violations

### Common Symptoms

- Exit code 60-67 on task completion
- Error: "Protocol violation detected"
- Manifest validation failure
- Missing @task tags in code
- Insufficient key_findings in research output

### Exit Codes Reference

| Code | Protocol | Common Issue |
|------|----------|--------------|
| 60 | Research | Missing key_findings or code modifications |
| 61 | Consensus | Invalid voting matrix or confidence scores |
| 62 | Specification | Missing RFC 2119 keywords or version |
| 63 | Decomposition | Too many siblings or unclear descriptions |
| 64 | Implementation | Missing @task tags on new functions |
| 65 | Contribution | Missing @task/@contribution tags |
| 66 | Release | Invalid semver or missing changelog |
| 67 | Generic | Unknown protocol or generic violation |

### Diagnosis

```bash
# View detailed violation report
cleo validate-protocol T1234 --verbose

# Check manifest entry
jq 'select(.id == "T1234-output")' claudedocs/agent-outputs/MANIFEST.jsonl

# Verify protocol requirements
cleo protocol show research  # or: consensus, specification, etc.
```

### Resolution

**For research violations (exit 60):**
```bash
# Check if code was modified (RSCH-001)
git diff --name-only HEAD | grep -E '\.(sh|js|py)$'

# Add more key_findings (RSCH-006)
jq '.key_findings += ["Additional research finding"]' MANIFEST.jsonl

# Ensure 3-7 key findings in manifest
```

**For implementation violations (exit 64):**
```bash
# Add @task tags to new functions (IMPL-003)
# Before:
my_new_function() {
    # logic
}

# After:
# @task T1234
# @layer validation
my_new_function() {
    # logic
}
```

**For specification violations (exit 62):**
```bash
# Ensure RFC 2119 keywords present (SPEC-001)
grep -E "MUST|SHOULD|MAY" docs/specs/FEATURE.md

# Add version to specification (SPEC-002)
echo "**Version**: 1.0.0" >> docs/specs/FEATURE.md
```

**For commit enforcement violations:**
```bash
# Add task ID to commit message
git commit --amend -m "feat: Feature description (T1234)"

# Or bypass if necessary (logged)
git commit --no-verify -m "emergency fix"
```

### Prevention

1. **Use protocol templates**: Start with proper structure
2. **Validate early**: Run validation before completion
3. **Enable strict mode**: Catch warnings early in development
4. **Review enforcement guide**: See `docs/guides/protocol-enforcement.md`

For complete protocol enforcement documentation, see: `docs/guides/protocol-enforcement.md`

---

## Nexus Errors (70-79)

### Overview

Exit codes 70-79 are reserved for CLEO Nexus cross-project intelligence system errors. These occur when working with multiple registered projects and global intelligence features.

### Exit Codes Reference

| Code | Name | Description | Fix |
|------|------|-------------|-----|
| 70 | E_NEXUS_NOT_INITIALIZED | Nexus directory missing | Run `cleo nexus init` |
| 71 | E_NEXUS_PROJECT_NOT_FOUND | Project not registered | Run `cleo nexus register <path>` |
| 72 | E_NEXUS_PERMISSION_DENIED | Insufficient permissions | Check project permissions with `cleo nexus list` |
| 73 | E_NEXUS_INVALID_SYNTAX | Bad query syntax | Use format `project:task_id` |
| 74 | E_NEXUS_SYNC_FAILED | Sync operation failed | Check project path exists |
| 75 | E_NEXUS_REGISTRY_CORRUPT | Registry file invalid | Backup and reinitialize |
| 76 | E_NEXUS_PROJECT_EXISTS | Already registered | Use `cleo nexus sync` to update |
| 77 | E_NEXUS_QUERY_FAILED | Query operation failed | Check syntax and permissions |
| 78 | E_NEXUS_GRAPH_ERROR | Graph operation error | Check project task files |
| 79 | E_NEXUS_RESERVED | Reserved | Not currently used |

### Common Issues

#### Nexus Not Initialized (70)

**Symptom:**
```bash
$ cleo nexus register /path/to/project
ERROR: Nexus not initialized (E_NEXUS_NOT_INITIALIZED)
```

**Fix:**
```bash
cleo nexus init
cleo nexus register /path/to/project --name my-project
```

#### Project Not Found (71)

**Symptom:**
```bash
$ cleo show my-api:T123
ERROR: Project 'my-api' not found in registry (E_NEXUS_PROJECT_NOT_FOUND)
```

**Fix:**
```bash
# List registered projects
cleo nexus list

# Register missing project
cleo nexus register /path/to/my-api --name my-api

# Or use correct project name/alias
cleo show api:T123  # if 'api' is an alias
```

#### Permission Denied (72)

**Symptom:**
```bash
$ cleo update auth-lib:T456 --status done
ERROR: Permission denied (E_NEXUS_PERMISSION_DENIED)
Project 'my-api' has 'read' permission but 'write' required
```

**Fix:**
```bash
# Grant write permission
cleo nexus grant my-api auth-lib --permission write

# Or check current permissions
cleo nexus permissions --list
```

#### Invalid Syntax (73)

**Symptom:**
```bash
$ cleo show my::api:T123
ERROR: Invalid task reference syntax (E_NEXUS_INVALID_SYNTAX)
```

**Fix:**
```bash
# Correct format: project:task_id
cleo show my-api:T123

# Or current project (no prefix)
cleo show T123

# Or explicit current project
cleo show .:T123
```

#### Registry Corrupt (75)

**Symptom:**
```bash
$ cleo nexus list
ERROR: Registry file corrupted (E_NEXUS_REGISTRY_CORRUPT)
parse error: Invalid JSON
```

**Fix:**
```bash
# Backup corrupted registry
mv ~/.cleo/projects-registry.json ~/.cleo/projects-registry.json.backup

# Reinitialize
cleo nexus init

# Re-register projects
cleo nexus register /path/to/project1 --name project1
cleo nexus register /path/to/project2 --name project2
```

### Lifecycle Enforcement Errors (80-84)

**Note:** Lifecycle enforcement exit codes moved from 75-79 to 80-84 in v0.80.0 to avoid conflict with Nexus codes.

| Code | Name | Description | Fix |
|------|------|-------------|-----|
| 80 | E_LIFECYCLE_GATE_FAILED | Lifecycle prerequisites not met | Complete missing RCSD stages first |
| 81 | E_AUDIT_MISSING | Audit object incomplete | Add required audit fields |
| 82 | E_CIRCULAR_VALIDATION | Agent validating own work | Use different agent for validation |
| 83 | E_LIFECYCLE_TRANSITION_INVALID | Invalid state transition | Follow RCSD→IVTR pipeline order |
| 84 | E_PROVENANCE_REQUIRED | Provenance fields missing | Add createdBy/validatedBy fields |

---

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
