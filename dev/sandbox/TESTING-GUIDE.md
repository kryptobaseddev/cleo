# CLEO Sandbox Testing Guide

Comprehensive guide for running production-like tests in an isolated container environment.

## What is the Sandbox?

The CLEO Sandbox is a **production-like testing environment** that provides:

- **Complete isolation**: Test without affecting your development system
- **SSH access**: Full remote access like a real server
- **Reproducibility**: Consistent Fedora Linux environment
- **Safety**: No risk of data loss or system corruption
- **Automation**: Scripts for common testing scenarios

## Why Use the Sandbox?

### Before Release Testing
- Verify installation on clean system
- Test user onboarding flow
- Validate documentation accuracy
- Check for missing dependencies

### Production Simulation
- Test multi-project setups
- Verify session management
- Test concurrent operations
- Validate data persistence

### Integration Testing
- Test with real filesystem
- Verify JSON schema validation
- Test atomic operations
- Validate backup/restore

## Architecture

```
┌──────────────────────────────────────────────┐
│  Host System (Fedora Desktop)               │
│                                              │
│  ┌────────────────────────────────────────┐ │
│  │  Podman Container (cleo-sandbox)       │ │
│  │                                        │ │
│  │  OS: Fedora Linux (latest)            │ │
│  │  User: testuser (password: testpass)  │ │
│  │  SSH: Port 2222                        │ │
│  │  Dependencies: bash, jq, git, bats    │ │
│  │                                        │ │
│  │  /home/testuser/                      │ │
│  │  ├── projects/     # CLEO source      │ │
│  │  ├── test-project/ # Test projects    │ │
│  │  └── .cleo/        # Installation     │ │
│  │                                        │ │
│  └────────────────────────────────────────┘ │
│           ↑                                  │
│           │ SSH (localhost:2222)             │
│           │ Key: ~/.cleo/sandbox/ssh/        │
└───────────┼──────────────────────────────────┘
            │
    sandbox-manager.sh
```

## Components

### 1. Container Image (`Containerfile`)
- Based on Fedora (matches host system)
- Pre-installed: bash, jq, git, openssh, sudo, vim, bats
- Configured SSH server on port 2222
- Test user with sudo access

### 2. Management Script (`sandbox-manager.sh`)
Main tool for sandbox lifecycle:
- `build` - Build container image
- `start` - Start sandbox
- `stop` - Stop sandbox
- `destroy` - Remove sandbox
- `ssh` - Connect interactively
- `exec` - Run single command
- `status` - Show sandbox state
- `logs` - View container logs

### 3. Test Runner (`test-runner.sh`)
Automated test scenarios:
- Fresh installation test
- Basic workflow test
- Multi-project test
- Error handling test
- Data persistence test

### 4. Documentation
- `README.md` - Complete reference
- `QUICKSTART.md` - Getting started (this file)
- `TESTING-GUIDE.md` - Testing best practices

## Quick Reference

### Essential Commands

```bash
# Lifecycle
./sandbox-manager.sh start          # Start sandbox
./sandbox-manager.sh status         # Check status
./sandbox-manager.sh ssh            # Interactive shell
./sandbox-manager.sh destroy        # Clean up

# Testing
./sandbox-manager.sh exec "command" # Run command
./test-runner.sh                    # Run all tests
./test-runner.sh workflow           # Run specific test

# Debugging
./sandbox-manager.sh logs           # View logs
./sandbox-manager.sh logs -f        # Follow logs
```

### File Locations

On Host:
- Scripts: `/mnt/projects/claude-todo/dev/sandbox/`
- SSH Keys: `~/.cleo/sandbox/ssh/`

In Sandbox:
- CLEO Source: `/home/testuser/projects/`
- Installation: `/home/testuser/.cleo/`
- Test Projects: `/home/testuser/test-project/`

## Testing Workflows

### 1. Installation Testing

Verify CLEO installs correctly on a fresh system:

```bash
# Start sandbox
./sandbox-manager.sh start

# Copy CLEO to sandbox (already done on start)
# CLEO is at /home/testuser/projects

# Test installation
./sandbox-manager.sh exec "cd ~/projects && ./install.sh --check-deps"
./sandbox-manager.sh exec "cd ~/projects && ./install.sh"
./sandbox-manager.sh exec "/home/testuser/.local/bin/cleo version"
```

### 2. User Workflow Testing

Test typical user operations:

```bash
# SSH into sandbox
./sandbox-manager.sh ssh

# Inside sandbox - complete workflow
mkdir ~/myproject && cd ~/myproject
cleo init

# Bootstrap first epic (multi-session mode)
cat > .cleo/todo.json <<'EOF'
{
  "$schema": "../schemas/todo.schema.json",
  "version": "2.6.0",
  "tasks": [{
    "id": "T001",
    "title": "Project Setup",
    "description": "Initial setup",
    "status": "pending",
    "type": "epic",
    "created": "2026-02-04T17:00:00Z",
    "updated": "2026-02-04T17:00:00Z"
  }]
}
EOF

# Start session and work
cleo session start --scope epic:T001 --auto-focus --name "Setup"
cleo add "Task 1"
cleo add "Task 2"
cleo list
cleo done T002
cleo session end
```

### 3. Multi-Project Testing

Test project isolation:

```bash
./sandbox-manager.sh ssh

# Create two projects
mkdir -p ~/project-a ~/project-b

# Initialize both
cd ~/project-a && cleo init
cd ~/project-b && cleo init

# Add tasks to each (after session setup)
cd ~/project-a && cleo add "Feature A"
cd ~/project-b && cleo add "Feature B"

# Verify isolation
cd ~/project-a && cleo list  # Only sees project-a tasks
cd ~/project-b && cleo list  # Only sees project-b tasks
```

### 4. Error Handling Testing

Test graceful error handling:

```bash
./sandbox-manager.sh ssh

cd ~/myproject

# Test invalid operations
cleo show T999                # Invalid task ID
cleo update T999 --title "X" # Update non-existent task
cd /tmp && cleo list          # Operation outside project

# Verify error messages are helpful
```

### 5. Data Integrity Testing

Test data persistence and validation:

```bash
./sandbox-manager.sh ssh

cd ~/myproject

# Add task and verify JSON
cleo add "Integrity test"
cat .cleo/todo.json | jq '.tasks[] | select(.title == "Integrity test")'

# Verify schema compliance
cleo --validate

# Test backup creation
ls -la .cleo/.backups/
```

## Automated Testing

### Run All Tests

```bash
cd /mnt/projects/claude-todo/dev/sandbox
./test-runner.sh
```

Output shows:
- ✓ Passed tests
- ✗ Failed tests
- Summary at end

### Run Specific Tests

```bash
./test-runner.sh fresh       # Installation test
./test-runner.sh workflow    # Basic workflow
./test-runner.sh multi       # Multi-project
./test-runner.sh errors      # Error handling
./test-runner.sh persistence # Data persistence
```

### Custom Test Scripts

Create your own:

```bash
#!/usr/bin/env bash
# my-custom-test.sh

MANAGER="./sandbox-manager.sh"

# Ensure sandbox is running
$MANAGER start

# Run your tests
$MANAGER exec "cd ~/myproject && cleo list"
$MANAGER exec "cd ~/myproject && cleo add 'Custom test'"

# Cleanup
$MANAGER destroy
```

## Best Practices

### 1. Start Fresh

Always start with a clean sandbox for important tests:

```bash
./sandbox-manager.sh destroy
./sandbox-manager.sh start
```

### 2. Test Incrementally

Build up complexity:
1. Test installation
2. Test single operation
3. Test workflow
4. Test edge cases

### 3. Document Findings

Keep notes of issues found:
- What operation failed?
- What was the error message?
- How to reproduce?
- Expected vs actual behavior

### 4. Use Realistic Data

Test with real-world scenarios:
- Typical task descriptions
- Realistic project structures
- Common error conditions
- Normal usage patterns

### 5. Verify Cleanup

After tests, check:
- Sandbox is stopped
- No hanging processes
- Disk space freed

```bash
./sandbox-manager.sh status
podman ps -a | grep cleo
```

## Troubleshooting

### Sandbox Won't Start

```bash
# Check if port 2222 is busy
sudo lsof -i :2222

# Check container status
podman ps -a | grep cleo

# View detailed logs
./sandbox-manager.sh logs

# Force cleanup and rebuild
podman rm -f cleo-sandbox
podman rmi cleo-sandbox:latest
./sandbox-manager.sh build
./sandbox-manager.sh start
```

### SSH Connection Issues

```bash
# Verify SSH keys
ls -la ~/.cleo/sandbox/ssh/
stat -c "%a" ~/.cleo/sandbox/ssh/sandbox_key  # Should be 600

# Test direct SSH
ssh -p 2222 -i ~/.cleo/sandbox/ssh/sandbox_key testuser@localhost

# Check SSH service in container
./sandbox-manager.sh logs | grep sshd
```

### CLEO Operation Failures

```bash
# SSH into sandbox to debug
./sandbox-manager.sh ssh

# Check installation
which cleo
cleo --version
cleo --validate

# Check project state
cd ~/myproject
ls -la .cleo/
cat .cleo/config.json | jq '.'

# Check for errors
cat .cleo/todo-log.jsonl | jq '.[] | select(.level == "ERROR")'
```

### Container Storage Issues

```bash
# Check disk usage
podman system df

# Clean up old containers and images
podman system prune -a

# Remove specific container
podman rm -f cleo-sandbox

# Remove specific image
podman rmi cleo-sandbox:latest
```

## Integration with Development

### Pre-Release Checklist

Before each release, run sandbox tests:

```bash
cd dev/sandbox

# 1. Build fresh sandbox
./sandbox-manager.sh destroy
./sandbox-manager.sh build

# 2. Test installation
./test-runner.sh fresh

# 3. Test workflows
./test-runner.sh workflow

# 4. Test edge cases
./test-runner.sh errors

# 5. Review results
# All tests should pass

# 6. Cleanup
./sandbox-manager.sh destroy
```

### CI/CD Integration

Add to your CI pipeline:

```yaml
# .github/workflows/integration-test.yml
name: Integration Tests

on: [push, pull_request]

jobs:
  sandbox-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v2

      - name: Install Podman
        run: sudo apt-get update && sudo apt-get install -y podman

      - name: Run Sandbox Tests
        run: |
          cd dev/sandbox
          ./sandbox-manager.sh start
          ./test-runner.sh
          EXIT_CODE=$?
          ./sandbox-manager.sh destroy
          exit $EXIT_CODE
```

### Manual QA Process

Use sandbox for manual QA:

1. **Setup Phase**
   ```bash
   ./sandbox-manager.sh start
   ./sandbox-manager.sh ssh
   ```

2. **Execute Test Cases**
   - Follow test plan
   - Document results
   - Take notes on UX

3. **Cleanup Phase**
   ```bash
   exit  # Leave SSH
   ./sandbox-manager.sh destroy
   ```

## Advanced Topics

### Multiple Sandboxes

Run multiple sandboxes for parallel testing:

```bash
# Modify sandbox-manager.sh to use different names
CONTAINER_NAME="cleo-sandbox-test1" SSH_PORT=2222 ./sandbox-manager.sh start
CONTAINER_NAME="cleo-sandbox-test2" SSH_PORT=2223 ./sandbox-manager.sh start
```

### Performance Benchmarking

```bash
./sandbox-manager.sh ssh

cd ~/myproject

# Benchmark operations
time cleo add "Benchmark test"
time cleo list
time cleo show T001

# Stress test
for i in {1..100}; do
  cleo add "Task $i"
done
time cleo list
```

### Snapshot and Restore

```bash
# Create snapshot
podman commit cleo-sandbox cleo-sandbox:snapshot-1

# Restore from snapshot
podman rm -f cleo-sandbox
podman run -d --name cleo-sandbox cleo-sandbox:snapshot-1
```

## Resources

- [Sandbox README](README.md) - Complete reference
- [Quick Start Guide](QUICKSTART.md) - Getting started
- [CLEO Documentation](../../docs/) - Main docs
- [Testing Framework](../../tests/) - Unit/integration tests
- [Podman Documentation](https://docs.podman.io/) - Container runtime

## Contributing

Found issues during sandbox testing? Please report:

1. Open issue on GitHub
2. Include sandbox test output
3. Provide steps to reproduce
4. Tag with `sandbox` label

## Summary

The CLEO Sandbox provides a production-like environment for:
- ✅ Testing installations
- ✅ Validating workflows
- ✅ Reproducing issues
- ✅ Pre-release verification
- ✅ Documentation validation

Use it regularly to catch issues before they reach users!
