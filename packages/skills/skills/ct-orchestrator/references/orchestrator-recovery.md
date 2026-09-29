# Orchestrator: Error Recovery

> Referenced from: @skills/ct-orchestrator/SKILL.md
> Load when: Need details on error handling, recovery procedures, context budget monitoring, or session lifecycle management

## Error Recovery

| Failure | Detection | Recovery |
|---------|-----------|----------|
| No output file | `test -f <path>` fails | Re-spawn with clearer instructions |
| No manifest entry | `{{RESEARCH_SHOW_CMD}}` fails | Manual entry or re-spawn |
| Task not completed | Status != done | Orchestrator completes manually |
| Partial status | `status: partial` | Spawn continuation agent |
| Blocked status | `status: blocked` | Flag for human review |

---

## Context Budget Monitoring

```bash
# Check context usage for an epic
cleo orchestrate context T1575
```

**Status Thresholds**:
| Status | Usage | Action |
|--------|-------|--------|
| `ok` | <70% | Continue orchestration |
| `warning` | 70-89% | Delegate current work soon |
| `critical` | >=90% | STOP - Delegate immediately |

---

## Session Lifecycle Management

Orchestrator sessions may span multiple Claude conversations. This is expected and supported by design.

### Session Timeout and Retention

| Setting | Default | Description |
|---------|---------|-------------|
| Session timeout | 72 hours | Active sessions auto-end after 72h inactivity |
| Auto-end threshold | 7 days | `retention.autoEndActiveAfterDays` config |
| Stale session cleanup | Manual | Use `cleo session gc` for cleanup |

**Key points:**
- Sessions can legitimately span multiple days of work
- Long-running orchestration work is expected
- Sessions persist across Claude conversation boundaries

### Cleanup Commands

```bash
# Standard garbage collection
cleo session gc

# Also end active sessions older than N days
cleo session gc --max-age 7

# There is no dry-run; inspect first
cleo session list --status active
```

### Configuration

```bash
# View current retention settings
cleo config get retention

# Adjust auto-end threshold for active sessions
cleo config set retention.autoEndActiveAfterDays 14  # Extend to 2 weeks
```

### Best Practices

1. **Session end on completion**: Always end sessions when work completes
   ```bash
   cleo session end --note "Epic T1575 phase 1 complete"
   ```

2. **Session suspend for long waits**: Suspend when blocked on external factors
   ```bash
   cleo session suspend <sessionId> --reason "Awaiting code review"
   ```

3. **Periodic cleanup**: Run garbage collection periodically to remove stale sessions
   ```bash
   cleo session gc --max-age 7
   ```

4. **Multi-day work**: No need to restart sessions daily - orchestrator sessions are designed for extended work periods

---

## Validation

```bash
# Validate one task's subagent output
cleo orchestrate validate T1586

# Validate a specific output file, and that a manifest entry was appended
cleo orchestrate validate T1586 --file <output-path> --manifest
```
