# Migration Troubleshooting Guide

## Error Messages

### "Migration imported 0 tasks"

**Cause**: JSON files have no tasks or are corrupted

**Solution**:

1. Check JSON files: `cat .cleo/todo.json | jq '.tasks | length'`
2. If 0 tasks, check if this is expected
3. If corrupted, restore from git: `git checkout .cleo/todo.json`

### "Lock acquisition failed"

**Cause**: Another migration is running

**Solution**:

1. Check for running processes: `ps aux | grep cleo`
2. Wait or kill stuck process
3. Retry migration

### "Checksum mismatch"

**Cause**: Backup file corrupted during copy

**Solution**:

1. Check backup integrity
2. Restore from numbered backups: `cleo restore <id>`
3. Retry migration

### "Database locked"

**Cause**: Another process has database open

**Solution**:

1. Close other CLEO processes
2. Wait 30 seconds for lock timeout
3. Retry migration

### "JSON validation failed"

**Cause**: todo.json or other JSON files corrupted

**Solution**:

1. Check specific error in log
2. Validate JSON: `cat .cleo/todo.json | jq .`
3. Fix or restore corrupted file

### "Singleton state invalid"

**Cause**: Cached database reference stale

**Solution**:

1. This should auto-resolve
2. If persistent, restart process
3. Check .cleo/.migration-state.json

## Diagnostic Commands

### Check Migration State

```bash
cat .cleo/.migration-state.json
```

### View Latest Log

```bash
tail -f .cleo/logs/migration-$(ls -t .cleo/logs/migration-*.jsonl | head -1)
```

### Validate Database

```bash
 cleo validate --full
```

### Check Backups

```bash
 cleo backup --list
 ls -la .cleo/backups/safety/
```

### Count Tasks

```bash
# JSON
cat .cleo/todo.json | jq '.tasks | length'

# SQLite
 cleo list | wc -l
```

## Getting Help

1. Check logs: `.cleo/logs/migration-*.jsonl`
2. Check state: `.cleo/.migration-state.json`
3. File issue: https://github.com/anomalyco/opencode/issues
