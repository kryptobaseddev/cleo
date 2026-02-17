# CLEO Sandbox Quick Start Guide

Complete guide to testing CLEO in the sandbox environment.

## Prerequisites

```bash
# Ensure you're in the sandbox directory
cd /mnt/projects/claude-todo/dev/sandbox
```

## Starting the Sandbox

```bash
# Build and start (first time)
./sandbox-manager.sh start

# Check status
./sandbox-manager.sh status
```

## SSH Access

```bash
# Interactive shell
./sandbox-manager.sh ssh

# Execute single command
./sandbox-manager.sh exec "command"
```

## Testing CLEO Installation

### 1. Install CLEO

The CLEO source is already copied to `/home/testuser/projects` in the sandbox.

```bash
# Check dependencies
./sandbox-manager.sh exec "cd ~/projects && ./install.sh --check-deps"

# Install CLEO
./sandbox-manager.sh exec "cd ~/projects && ./install.sh"

# Verify installation
./sandbox-manager.sh exec "/home/testuser/.local/bin/cleo version"
```

### 2. Create a Test Project

CLEO uses multi-session mode by default. Here's the proper bootstrap workflow:

```bash
# SSH into sandbox for interactive testing
./sandbox-manager.sh ssh
```

Inside the sandbox:

```bash
# Create and initialize project
mkdir -p ~/myproject
cd ~/myproject
cleo init

# The default config requires sessions. For testing, we can modify this:
# Option A: Disable multi-session mode for simpler testing
jq '.session.requireSession = false | .session.autoDiscoveryOnStart = false' .cleo/config.json > /tmp/config.json && mv /tmp/config.json .cleo/config.json

# Option B: Use proper session workflow (recommended for production testing)
# 1. Create bootstrap todo.json with an epic manually
cat > .cleo/todo.json <<'EOF'
{
  "$schema": "../schemas/todo.schema.json",
  "version": "2.6.0",
  "tasks": [
    {
      "id": "T001",
      "title": "Project Setup",
      "description": "Initial project setup and configuration",
      "status": "pending",
      "type": "epic",
      "created": "2026-02-04T17:00:00Z",
      "updated": "2026-02-04T17:00:00Z"
    }
  ]
}
EOF

# 2. Start session for the epic
cleo session start --scope epic:T001 --auto-focus --name "Setup Session"

# 3. Now you can add tasks
cleo add "Setup development environment"
cleo add "Write documentation"
```

### 3. Basic Workflow Test

With session started (Option B above):

```bash
# List tasks
cleo list

# Show task details
cleo show T002

# Set focus
cleo focus set T002

# Update task
cleo update T002 --notes "Added configuration files"

# Complete task
cleo done T002 --notes "Setup complete"

# End session
cleo session end --note "Initial setup complete"
```

## Production-Like Testing Scenarios

### Scenario 1: Fresh User Experience

```bash
# SSH into sandbox
./sandbox-manager.sh ssh

# Simulate new user
cd ~
mkdir my-first-project
cd my-first-project

# Follow the official getting started workflow
cleo init
# ... follow bootstrap process above
```

### Scenario 2: Multi-Project Setup

```bash
./sandbox-manager.sh ssh

# Create multiple projects
mkdir -p ~/project-a ~/project-b

# Initialize each
cd ~/project-a && cleo init
cd ~/project-b && cleo init

# Verify isolation
cd ~/project-a && cleo list  # Should show only project-a tasks
cd ~/project-b && cleo list  # Should show only project-b tasks
```

### Scenario 3: Session Management

```bash
./sandbox-manager.sh ssh

cd ~/myproject

# List all sessions
cleo session list

# Start multiple sessions for different epics
cleo session start --scope epic:T001 --auto-focus --name "Feature A"
# ... work on Feature A ...
cleo session end

cleo session start --scope epic:T002 --auto-focus --name "Feature B"
# ... work on Feature B ...
cleo session end

# Resume a session
cleo session list
cleo session resume <session-id>
```

### Scenario 4: Epic and Task Hierarchy

```bash
./sandbox-manager.sh ssh

cd ~/myproject
cleo session start --scope epic:T001 --auto-focus --name "Development"

# Create epic with subtasks
cleo add "Authentication System" --type epic
cleo add "User login" --parent T002
cleo add "User registration" --parent T002
cleo add "Password reset" --parent T002

# View hierarchy
cleo list --parent T002
cleo tree
```

## Automated Testing

Run the automated test suite:

```bash
# Run all tests
./test-runner.sh

# Run specific scenario
./test-runner.sh workflow
./test-runner.sh multi
```

## Common Operations

### View Container Logs

```bash
# All logs
./sandbox-manager.sh logs

# Follow logs
./sandbox-manager.sh logs -f

# Last 50 lines
./sandbox-manager.sh logs --tail 50
```

### Copy Files To/From Sandbox

```bash
# Copy TO sandbox
podman cp /path/on/host cleo-sandbox:/home/testuser/destination

# Copy FROM sandbox
podman cp cleo-sandbox:/home/testuser/source /path/on/host
```

### Reset Sandbox

```bash
# Destroy and start fresh
./sandbox-manager.sh destroy
./sandbox-manager.sh start

# Re-copy CLEO and install
# (follow installation steps above)
```

### Debug Inside Sandbox

```bash
# SSH in
./sandbox-manager.sh ssh

# Check CLEO state
cd ~/myproject
ls -la .cleo/
cat .cleo/todo.json | jq '.'
cat .cleo/config.json | jq '.session'

# Check logs
cat .cleo/todo-log.jsonl | jq '.[-5:]'  # Last 5 log entries

# Verify installation
which cleo
cleo --version
cleo --validate
```

## Troubleshooting

### "Operation requires an active session"

This is expected with multi-session mode. Solutions:

1. **Disable multi-session (for testing)**:
   ```bash
   cd ~/your-project
   jq '.session.requireSession = false' .cleo/config.json > /tmp/config.json && mv /tmp/config.json .cleo/config.json
   ```

2. **Use proper session workflow (recommended)**:
   - Create an epic first (bootstrap it in todo.json if needed)
   - Start a session: `cleo session start --scope epic:T001 --auto-focus --name "Session Name"`
   - Perform operations
   - End session: `cleo session end`

### SSH Connection Refused

```bash
# Check if container is running
./sandbox-manager.sh status

# Check SSH service in container
./sandbox-manager.sh logs | grep sshd

# Restart sandbox
./sandbox-manager.sh stop
./sandbox-manager.sh start
```

### Permission Denied on SSH Key

```bash
# Keys are stored in home directory now
ls -la ~/.cleo/sandbox/ssh/

# Fix permissions
chmod 600 ~/.cleo/sandbox/ssh/sandbox_key
chmod 644 ~/.cleo/sandbox/ssh/sandbox_key.pub
```

### Container Won't Start

```bash
# Check if port is in use
sudo lsof -i :2222

# Use different port
SSH_PORT=2223 ./sandbox-manager.sh start
```

## Advanced Usage

### Custom Test Script

Create your own test script:

```bash
#!/usr/bin/env bash
# my-test.sh

MANAGER="./sandbox-manager.sh"

# Your test logic
$MANAGER exec "cd ~/myproject && cleo list"
$MANAGER exec "cd ~/myproject && cleo add 'My test task'"
# ... more commands
```

### Performance Testing

```bash
./sandbox-manager.sh ssh

cd ~/myproject
time cleo add "Performance test"
time cleo list
time cleo show T001
```

### Integration with CI/CD

```yaml
# Example GitHub Actions
- name: Test in Sandbox
  run: |
    cd dev/sandbox
    ./sandbox-manager.sh start
    ./test-runner.sh
    ./sandbox-manager.sh destroy
```

## Best Practices

1. **Always start fresh for important tests**: `destroy` then `start`
2. **Use sessions properly**: Follow the multi-session workflow for production-like testing
3. **Test isolation**: Create separate projects for different test scenarios
4. **Document issues**: Keep notes of any problems found during testing
5. **Clean up**: Destroy sandbox when done to free resources

## Next Steps

- Read the full sandbox documentation: [README.md](README.md)
- Review CLEO documentation: [../../docs/](../../docs/)
- Run automated tests: `./test-runner.sh`
- Report issues: [GitHub Issues](https://github.com/yourusername/claude-todo/issues)

## Resources

- Sandbox Manager: `./sandbox-manager.sh help`
- CLEO Commands: `cleo --help`
- Session Guide: `cleo session --help`
- Multi-Session Docs: [../../docs/guides/sessions.md](../../docs/guides/sessions.md)
