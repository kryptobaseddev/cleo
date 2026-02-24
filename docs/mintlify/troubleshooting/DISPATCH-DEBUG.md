# Dispatch Troubleshooting Guide

## Common Issues

### Skill Not Being Selected

**Symptom**: Wrong skill selected for task

**Checklist**:
1. Check task type: `cleo show T1234 | jq '.task.type'`
2. Check task labels: `cleo show T1234 | jq '.task.labels'`
3. Check title keywords: Does title match dispatch patterns?
4. Check manifest: `cat skills/manifest.json | jq '.dispatch_matrix'`

**Debug Mode**:
```bash
export SKILL_DISPATCH_DEBUG=1
cleo orchestrator spawn T1234
```

### Empty Prompt Returned

**Symptom**: `orchestrator spawn` returns empty `prompt` field

**Causes**:
1. Token injection failed (special characters)
2. Template file missing
3. Required tokens not set

**Resolution**:
```bash
# Check token values
export TI_DEBUG=1
cleo orchestrator spawn T1234

# Verify template exists
ls -la skills/ct-{skill}/SKILL.md
```

### Manifest Entry Missing

**Symptom**: Subagent completes but no MANIFEST.jsonl entry

**Causes**:
1. Subagent didn't follow OUT-002
2. File path incorrect
3. JSON formatting error

**Resolution**:
```bash
# Check manifest
tail -5 claudedocs/agent-outputs/MANIFEST.jsonl

# Validate JSON
tail -1 claudedocs/agent-outputs/MANIFEST.jsonl | jq .
```

### Task Not Found

**Symptom**: `E_NOT_FOUND` when spawning

**Causes**:
1. Task completed and archived
2. Task ID typo
3. Wrong project directory

**Resolution**:
```bash
# Check active tasks
cleo exists T1234

# Check archive
cleo exists T1234 --include-archive

# Find similar
cleo find --id 123
```

## Debug Environment Variables

| Variable | Purpose |
|----------|---------|
| `SKILL_DISPATCH_DEBUG=1` | Show dispatch decision tree |
| `TI_DEBUG=1` | Show token injection details |
| `CLEO_DEBUG=1` | General CLEO debug output |

## Exit Code Reference

| Code | Error | Meaning |
|------|-------|---------|
| 0 | Success | Operation completed |
| 4 | E_NOT_FOUND | Task not found |
| 6 | E_VALIDATION | Token/template validation failed |
| 38 | E_FOCUS_REQUIRED | Session needs focus |
| 100 | E_SESSION_DISCOVERY | Session scope required |

## Related

- [Skill Dispatch Algorithm](../guides/SKILL-DISPATCH-ALGORITHM.md)
- [Protocol Injection Flow](../guides/PROTOCOL-INJECTION-FLOW.md)
