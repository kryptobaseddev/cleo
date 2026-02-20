# File Locking Quick Reference

## For Users

**Nothing changed** - all locking is automatic. Your existing commands work the same, just safer now.

## For Developers

### Automatic Locking (Most Common)

Use `save_json()` or `atomic_write()` - locking is handled automatically:

```bash
# Already protected by locking
echo '{"task": "data"}' | save_json "$file"

# Also protected
echo "content" | atomic_write "$file"
```

### Manual Locking (Advanced)

For custom read-modify-write operations:

```bash
#!/bin/bash
source lib/file-ops.sh

file="data.json"
lock_fd=""

# Acquire lock
if ! lock_file "$file" lock_fd 30; then
    echo "Failed to acquire lock"
    exit 1
fi

# Critical section - you have exclusive access
current=$(cat "$file")
modified=$(echo "$current" | jq '.counter += 1')
echo "$modified" > "$file"

# Release lock
unlock_file "$lock_fd"
```

### With Error Handling

```bash
lock_fd=""

# Acquire lock
if ! lock_file "$file" lock_fd 30; then
    echo "Failed to acquire lock"
    exit 1
fi

# Set trap to ensure unlock on error
trap "unlock_file '$lock_fd'" EXIT ERR INT TERM

# Do your work
process_file "$file"

# Clean unlock
unlock_file "$lock_fd"
trap - EXIT ERR INT TERM
```

## Function Signatures

### lock_file
```bash
lock_file <file_path> <fd_variable_name> [timeout_seconds]
```

**Parameters**:
- `file_path`: Path to file to lock
- `fd_variable_name`: Variable name to store the FD (e.g., "lock_fd")
- `timeout_seconds`: Optional, default 30

**Returns**:
- 0 on success
- E_LOCK_FAILED (8) on failure

**Example**:
```bash
lock_fd=""
lock_file "/path/to/file" lock_fd 10  # 10 second timeout
```

### unlock_file
```bash
unlock_file [file_descriptor]
```

**Parameters**:
- `file_descriptor`: FD to unlock (optional, uses LOCK_FD if omitted)

**Returns**: Always 0 (safe to call anytime)

**Example**:
```bash
unlock_file "$lock_fd"
# or
unlock_file  # Uses LOCK_FD variable
```

## Common Patterns

### Pattern 1: Simple Read-Modify-Write
```bash
lock_fd=""
lock_file "$file" lock_fd

data=$(cat "$file")
modified=$(process "$data")
echo "$modified" > "$file"

unlock_file "$lock_fd"
```

### Pattern 2: Multiple Operations
```bash
lock_fd=""
lock_file "$file" lock_fd
trap "unlock_file '$lock_fd'" EXIT

# Multiple operations all protected
validate_file "$file"
backup_file "$file"
modify_file "$file"
check_result "$file"

unlock_file "$lock_fd"
trap - EXIT
```

### Pattern 3: Conditional Lock
```bash
if need_exclusive_access; then
    lock_fd=""
    lock_file "$file" lock_fd
    trap "unlock_file '$lock_fd'" EXIT
fi

# Do work (locked if needed)
process "$file"

if [[ -n "$lock_fd" ]]; then
    unlock_file "$lock_fd"
    trap - EXIT
fi
```

## Best Practices

### DO
- ✓ Use `save_json()` when possible (automatic locking)
- ✓ Set appropriate timeouts (default 30s is usually fine)
- ✓ Use trap to ensure unlock on error
- ✓ Check lock_file return value
- ✓ Minimize time spent holding lock

### DON'T
- ✗ Hold locks during long operations
- ✗ Try to lock the same file twice in same process
- ✗ Forget to unlock (always use trap or explicit unlock)
- ✗ Assume locks work across network filesystems
- ✗ Use locks for reading (unless preventing concurrent writes)

## Troubleshooting

### "Failed to acquire lock (timeout after Xs)"
**Cause**: Another process holds the lock
**Solution**:
- Wait for other process to complete
- Increase timeout if legitimate long operation
- Check for deadlocks or stuck processes

### "File descriptor X already in use"
**Cause**: Too many simultaneous locks
**Solution**:
- Unlock existing locks before acquiring new ones
- Don't nest locks on same file
- Check for fd leaks (always unlock)

### Lock file remains after process exits
**Behavior**: This is normal - lock files persist
**Not a problem**: The lock itself is released when FD closes
**Cleanup**: Lock files can be safely deleted anytime

## Testing Your Code

### Unit Test Template
```bash
@test "my operation handles concurrent access" {
    # Start concurrent operations
    for i in {1..3}; do
        (source lib/file-ops.sh; my_operation "$file") &
    done

    wait

    # Verify no corruption
    jq empty "$file"  # Valid JSON
    [ $(jq '.counter' "$file") -eq 3 ]  # Correct result
}
```

### Manual Test
```bash
# Terminal 1
lock_fd=""; lock_file test.json lock_fd; sleep 10; unlock_file "$lock_fd"

# Terminal 2 (run immediately after)
lock_file test.json lock_fd 5  # Should wait, then timeout or succeed
```

## Error Codes

```bash
E_SUCCESS=0          # Lock acquired/released successfully
E_INVALID_ARGS=1     # Missing required parameter
E_LOCK_FAILED=8      # Timeout or unable to create lock file
```

## Performance

- **Sequential operations**: <5% overhead
- **Lock acquisition**: Usually instantaneous
- **10 locked writes**: <500ms
- **Concurrent operations**: Serialized (slower but safe)

## System Requirements

- `flock` command (standard on modern Linux)
- Bash 4.0+
- File descriptors 200-210 available
- Same filesystem (locks don't work across NFS)

## See Also

- Full documentation: `claudedocs/T132-race-condition-fix.md`
- Implementation: `lib/file-ops.sh`
- Tests: `tests/unit/file-locking.bats`
- Integration test: `tests/test-race-condition-fix.sh`
