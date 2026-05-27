# T623: Testing Guide — Web Server Persistence

## Test Scenario 1: Terminal Close Persistence

### Setup
```bash
# Start fresh session
cd /mnt/projects/cleocode
pnpm run build
cleo web stop  # ensure no running instance
```

### Before Fix (Original Behavior)

```bash
# Terminal 1
$ cleo web start
✓ Server running on port 3456 (PID: 12345)

# Note PID in output, then close terminal without running `cleo web stop`
# (kill the terminal window or Ctrl+C)

# Terminal 2 (new window)
$ cleo web status
{ running: false, pid: null, ... }  # FALSE — process actually died

$ curl http://127.0.0.1:3456
curl: (7) Failed to connect to 127.0.0.1 port 3456: Connection refused
```

### After Fix (New Behavior)

```bash
# Terminal 1
$ cleo web start
✓ Server running on port 3456 (PID: 12345)
  Logs: ~/.local/share/cleo/logs/web-server.log

# Close terminal without running `cleo web stop`
# (kill the terminal window or Ctrl+C)

# Terminal 2 (new window)
$ cleo web status
{
  running: true,
  pid: 12345,
  port: 3456,
  host: "127.0.0.1",
  url: "http://127.0.0.1:3456"
}

$ curl http://127.0.0.1:3456
(HTML response from studio server)

$ tail -20 ~/.local/share/cleo/logs/web-server.log
Listening on http://127.0.0.1:3456
(server logs from startup)
```

**Verification**: PID in status matches original output → process survived terminal close

## Test Scenario 2: Graceful Shutdown

### Setup
```bash
cleo web start --port 3457
sleep 2  # let server fully start
```

### Before Fix (Original Behavior)

```bash
# Take ~2-5 seconds, may force kill
$ cleo web stop
✓ Server stopped

# Some tests would show abrupt termination in logs
```

### After Fix (New Behavior)

```bash
# Take ~2-5 seconds (or up to 30s if processing requests)
$ cleo web stop
✓ Server stopped

# Check logs show graceful shutdown
$ tail -5 ~/.local/share/cleo/logs/web-server.log
(graceful shutdown messages from studio)
```

**Expected duration**: 2-5 seconds if idle, up to 30 seconds if processing

## Test Scenario 3: Restart Command

### Before Fix
```bash
$ cleo web restart
error: Unknown command 'web restart'
```

### After Fix
```bash
$ cleo web restart --port 3458
✓ Server stopped (if running)
✓ Server running on port 3458
  Logs: ~/.local/share/cleo/logs/web-server.log

$ cleo web status
{
  running: true,
  pid: 12346,  # Different from before
  port: 3458,  # New port
  ...
}
```

**Verification**: New PID different from old, port changed successfully

## Test Scenario 4: Log File Accumulation

### Setup
```bash
# Multiple start/stop cycles
for i in {1..5}; do
  cleo web start
  sleep 2
  cleo web stop
done
```

### Verification

```bash
# Log file should append (not truncate)
$ wc -l ~/.local/share/cleo/logs/web-server.log
150  (accumulated logs from 5 cycles, not just 1 cycle)

# Verify each startup logged
$ grep -c "Listening on" ~/.local/share/cleo/logs/web-server.log
5  (one per cycle)
```

**Expected**: Log grows with each cycle (append mode = 'a')

## Test Scenario 5: PID File Atomicity

### Setup
```bash
# Simulate rapid start/stop
(cleo web start; sleep 0.5; cleo web stop) &
(cleo web start; sleep 0.5; cleo web stop) &
wait
```

### Verification

```bash
# PID file should never be corrupt
$ cat ~/.local/share/cleo/web-server.pid
12349  # Valid integer, not partial/truncated

# No temporary files left behind
$ ls ~/.local/share/cleo/web-server.pid*
~/.local/share/cleo/web-server.pid  # Only main file, no .tmp leftover
```

**Expected**: No `.tmp` files remain, PID always valid integer

## Test Scenario 6: Cross-Terminus Signal Handling

### Setup (Linux/macOS only)
```bash
cleo web start
PID=$(cat ~/.local/share/cleo/web-server.pid)
```

### Before Fix

```bash
# Sending signals directly to process
$ kill -TERM $PID
# May not clean up properly (stdio/logging ignored)

$ kill -0 $PID  # check if running
# Process might still be running or zombie state
```

### After Fix

```bash
# Send SIGTERM directly (simulates what cleo web stop does)
$ kill -TERM $PID
$ sleep 2

$ kill -0 $PID  # check if running (exit 0 = running, exit 1 = not running)
# Process exits cleanly within grace period

$ tail ~/.local/share/cleo/logs/web-server.log
(graceful shutdown logged)
```

**Expected**: Process exits cleanly within 2-5 seconds

## Test Scenario 7: Already Running Check

### Setup
```bash
cleo web start --port 3460
```

### Before Fix

```bash
$ cleo web start --port 3461
# Would be allowed (no check)
# Two instances compete for connections
```

### After Fix

```bash
$ cleo web start --port 3461
Error: Server already running (PID: 12350)
# Correctly detects existing instance
```

**Verification**: Error message shows correct PID

## Test Scenario 8: Stale PID File Cleanup

### Setup
```bash
# Manually kill server outside CLEO
cleo web start
PID=$(cat ~/.local/share/cleo/web-server.pid)
kill -9 $PID  # force kill (bypass graceful shutdown)
```

### Verification

```bash
$ cleo web status
{ running: false, pid: null, ... }  # Correctly detects stale PID

$ cleo web start
✓ Server running (new PID)
# Allows new instance despite old PID file still existing initially
```

**Expected**: `getStatus()` validates PID is actually running before reporting running: true

## Log File Inspection

### Verify Logging is Working

```bash
# Fresh start
cleo web stop  # ensure stopped
rm ~/.local/share/cleo/logs/web-server.log  # clean slate

cleo web start
sleep 3

# Check log file exists and has content
$ ls -lh ~/.local/share/cleo/logs/web-server.log
-rw-r--r-- 1 user user 2.3K Apr 14 17:30 web-server.log

$ cat ~/.local/share/cleo/logs/web-server.log
Listening on http://127.0.0.1:3456
(studio app initialization messages)

$ tail -20 ~/.local/share/cleo/logs/web-server.log
(current output as server runs)
```

**Expected**: File grows as server runs, contains studio's console output

## Summary of Test Results

| Test | Before | After | Status |
|------|--------|-------|--------|
| Terminal close persistence | ❌ Process dies | ✅ Process survives | PASS |
| Graceful shutdown | ⚠️ May force kill | ✅ 30s grace period | PASS |
| Restart command | ❌ Command missing | ✅ Clean stop + start | PASS |
| Log accumulation | ❌ No logs | ✅ ~/.local/share/cleo/logs/ | PASS |
| PID file atomicity | ⚠️ Weak | ✅ Temp + rm pattern | PASS |
| Signal handling | ⚠️ No logging | ✅ Full logging | PASS |
| Already running check | ⚠️ Weak | ✅ Process validation | PASS |
| Stale PID cleanup | ⚠️ Manual | ✅ Automatic | PASS |

All tests should return PASS after fix is applied.
