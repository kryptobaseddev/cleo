# CLEO Sandbox Testing Environment

Production-like testing environment using Podman containers with full SSH access for realistic CLEO testing scenarios.

## Overview

The sandbox environment provides:
- **Isolated testing**: Clean Fedora Linux environment
- **SSH access**: Full remote access like a production server
- **Reproducibility**: Consistent environment for all tests
- **Safety**: No risk to development system
- **Automation**: Scripts for common testing scenarios

## Quick Start

```bash
# Start the sandbox (builds if needed)
./sandbox-manager.sh start

# Check status
./sandbox-manager.sh status

# SSH into sandbox
./sandbox-manager.sh ssh

# Run production tests
./test-runner.sh

# Clean up
./sandbox-manager.sh destroy
```

## Architecture

```
┌─────────────────────────────────────────┐
│  Host Machine (Fedora Desktop)          │
│                                          │
│  ┌────────────────────────────────────┐ │
│  │  Podman Container (cleo-sandbox)   │ │
│  │                                    │ │
│  │  - Fresh Fedora Linux              │ │
│  │  - SSH daemon on port 2222         │ │
│  │  - User: testuser                  │ │
│  │  - All dependencies installed      │ │
│  │                                    │ │
│  └────────────────────────────────────┘ │
│           ↑                              │
│           │ SSH (port 2222)              │
│           │ Key-based auth               │
└───────────┼──────────────────────────────┘
            │
     sandbox-manager.sh
```

## Components

### 1. Containerfile
Container image definition based on Fedora with:
- Bash, git, jq, and all CLEO dependencies
- SSH server configured for remote access
- Test user with sudo privileges
- Clean environment for realistic testing

### 2. sandbox-manager.sh
Main management script with commands:

| Command | Description |
|---------|-------------|
| `build` | Build the sandbox container image |
| `start` | Start the sandbox (builds if needed) |
| `stop` | Stop the running sandbox |
| `destroy` | Remove sandbox container |
| `ssh` | SSH into the sandbox |
| `exec <cmd>` | Execute command in sandbox |
| `status` | Show sandbox status |
| `logs` | View container logs |

### 3. test-runner.sh
Automated test suite running realistic scenarios:
- Fresh installation
- Basic task workflow
- Multi-project setup
- Error handling
- Data persistence

### 4. SSH Keys
Generated automatically in `dev/sandbox/ssh/`:
- `sandbox_key` - Private key (600 permissions)
- `sandbox_key.pub` - Public key (mounted into container)

## Usage Guide

### Starting the Sandbox

```bash
# First time - builds image and starts container
./sandbox-manager.sh start

# Output:
# [INFO] Generating SSH key pair for sandbox access...
# [INFO] Building sandbox container image...
# [SUCCESS] Sandbox image built: cleo-sandbox:latest
# [INFO] Creating and starting sandbox container...
# [SUCCESS] Sandbox container started and SSH is ready
# [INFO] Connect with: ./sandbox-manager.sh ssh
```

### Connecting to Sandbox

```bash
# Use the manager (recommended)
./sandbox-manager.sh ssh

# Or connect directly
ssh -p 2222 -i dev/sandbox/ssh/sandbox_key testuser@localhost

# Execute single command
./sandbox-manager.sh exec "cd ~ && pwd"
```

### Manual Testing Workflow

```bash
# 1. SSH into sandbox
./sandbox-manager.sh ssh

# 2. Inside sandbox - clone and install CLEO
git clone /path/to/cleo ~/cleo
cd ~/cleo
./install.sh

# 3. Test in a new project
mkdir ~/test-project
cd ~/test-project
cleo init

# 4. Run through typical workflow
cleo add "First task"
cleo session start --name "Test"
cleo focus set T001
cleo done T001
cleo session end

# 5. Exit sandbox
exit
```

### Automated Testing

```bash
# Run all test scenarios
./test-runner.sh

# Run specific scenario
./test-runner.sh workflow    # Basic workflow only
./test-runner.sh fresh       # Fresh installation only
./test-runner.sh multi       # Multi-project setup
./test-runner.sh errors      # Error handling
./test-runner.sh persistence # Data persistence
```

### Checking Status

```bash
./sandbox-manager.sh status

# Output:
# === CLEO Sandbox Status ===
#
# ✓ Image: cleo-sandbox:latest exists
#   Built: 5 minutes ago, Size: 523MB
#
# ✓ Container: cleo-sandbox is running
#   Uptime: Up 3 minutes
#   SSH: ssh -p 2222 -i dev/sandbox/ssh/sandbox_key testuser@localhost
#
# ✓ SSH Key: dev/sandbox/ssh/sandbox_key exists
```

### Viewing Logs

```bash
# View all logs
./sandbox-manager.sh logs

# Follow logs (Ctrl+C to exit)
./sandbox-manager.sh logs -f

# Last 20 lines
./sandbox-manager.sh logs --tail 20
```

### Cleanup

```bash
# Stop but keep container
./sandbox-manager.sh stop

# Destroy container (keeps image for fast restart)
./sandbox-manager.sh destroy

# Remove everything including image
./sandbox-manager.sh destroy
podman rmi cleo-sandbox:latest
```

## Test Scenarios

### 1. Fresh Installation Test
Simulates first-time user installing CLEO:
- Clone repository
- Check dependencies
- Run installation
- Verify cleo command works

### 2. Basic Workflow Test
Tests typical daily usage:
- Initialize project
- Create tasks
- Start session
- Set focus
- Complete tasks
- End session

### 3. Multi-Project Test
Verifies project isolation:
- Create multiple projects
- Add tasks to each
- Verify tasks don't leak between projects

### 4. Error Handling Test
Tests graceful error handling:
- Invalid task IDs
- Operations outside project
- Missing dependencies

### 5. Data Persistence Test
Verifies data integrity:
- Create tasks
- Verify JSON files exist
- Validate JSON structure

## Integration with CI/CD

The sandbox can be integrated into CI pipelines:

```yaml
# Example GitHub Actions workflow
- name: Setup CLEO Sandbox
  run: |
    cd dev/sandbox
    ./sandbox-manager.sh start

- name: Run Production Tests
  run: |
    cd dev/sandbox
    ./test-runner.sh

- name: Cleanup
  if: always()
  run: |
    cd dev/sandbox
    ./sandbox-manager.sh destroy
```

## Troubleshooting

### Container won't start
```bash
# Check if port 2222 is already in use
sudo lsof -i :2222

# Use different port
SSH_PORT=2223 ./sandbox-manager.sh start
```

### SSH connection fails
```bash
# Regenerate SSH keys
rm -rf dev/sandbox/ssh
./sandbox-manager.sh start

# Check container is running
podman ps | grep cleo-sandbox

# Check SSH service in container
./sandbox-manager.sh logs | grep sshd
```

### Permission denied errors
```bash
# Fix SSH key permissions
chmod 600 dev/sandbox/ssh/sandbox_key
chmod 644 dev/sandbox/ssh/sandbox_key.pub
```

### Container is slow
```bash
# Check container resources
podman stats cleo-sandbox

# Rebuild with fresh image
./sandbox-manager.sh destroy
podman rmi cleo-sandbox:latest
./sandbox-manager.sh build
```

## Advanced Usage

### Custom Testing Scripts

Create custom test scripts:

```bash
#!/usr/bin/env bash
# dev/sandbox/my-test.sh

MANAGER="$(dirname "$0")/sandbox-manager.sh"

# Run your custom tests
$MANAGER exec "cd ~/my-project && cleo add 'Custom test'"
$MANAGER exec "cd ~/my-project && cleo list"
```

### Debugging Failed Tests

```bash
# Keep sandbox running after test failure
./test-runner.sh workflow || true

# SSH in to investigate
./sandbox-manager.sh ssh

# Inside sandbox, check state
cd ~/test-project
cleo list
cat .cleo/todo.json
```

### Testing Installation Scripts

```bash
# Copy local CLEO into container
./sandbox-manager.sh exec "mkdir -p ~/cleo"
podman cp . cleo-sandbox:/home/testuser/cleo/

# Test installation
./sandbox-manager.sh exec "cd ~/cleo && ./install.sh"
```

### Performance Testing

```bash
# Time operations
./sandbox-manager.sh exec "time cleo add 'Performance test'"

# Stress test with many tasks
./sandbox-manager.sh exec "
  cd ~/test-project
  for i in {1..100}; do
    cleo add \"Task \$i\"
  done
  time cleo list
"
```

## Files Generated

```
dev/sandbox/
├── Containerfile              # Container image definition
├── sandbox-manager.sh         # Management script
├── test-runner.sh            # Automated tests
├── README.md                 # This file
└── ssh/                      # Generated on first run
    ├── sandbox_key           # Private SSH key (gitignored)
    └── sandbox_key.pub       # Public SSH key (gitignored)
```

## Security Notes

- SSH keys are generated locally and not committed to git
- Container runs as non-root user (testuser)
- SSH only accessible from localhost (127.0.0.1)
- Container network is isolated from host network
- All test data stays in container (destroyed with container)

## Best Practices

1. **Start fresh for important tests**: `destroy` then `start` for clean state
2. **Use automated tests first**: Manual testing for investigation only
3. **Check status before testing**: Ensure container is healthy
4. **Keep sandbox updated**: Rebuild periodically to get latest Fedora packages
5. **Document custom tests**: Add your scenarios to test-runner.sh

## Future Enhancements

Potential improvements:
- [ ] Support for multiple simultaneous sandboxes
- [ ] Save/restore sandbox snapshots
- [ ] Network testing scenarios
- [ ] Performance benchmarking suite
- [ ] Integration with GitHub Actions
- [ ] Support for different Linux distributions
- [ ] Multi-container scenarios (CLEO + database)

## References

- Podman documentation: https://docs.podman.io/
- CLEO testing guide: ../../docs/TESTING.md
- BATS test suite: ../../tests/
