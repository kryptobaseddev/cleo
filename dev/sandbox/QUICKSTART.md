# CLEO Sandbox Quick Start

## Prerequisites

- Podman installed (`podman --version`)
- You are in the sandbox directory: `cd /mnt/projects/claude-todo/dev/sandbox`

## Step 1: Start the Container

```bash
./sandbox-manager.sh start
```

This generates SSH keys (first run only), builds the Fedora container image (first run only), starts the container, and waits for SSH to be ready.

## Step 2: Deploy CLEO

```bash
./sandbox-manager.sh deploy
```

This copies the CLEO source into the container, runs `npm install` and `npm run build`, and symlinks the CLI to `/usr/local/bin/cleo`.

## Step 3: Run Tests

```bash
# Comprehensive test suite (97 assertions, 12 suites)
./adapter-test-runner.sh

# Basic workflow tests
./test-runner.sh

# Minimal smoke test
./simple-test.sh
```

## Common Commands

```bash
# Check container status
./sandbox-manager.sh status

# SSH into the container
./sandbox-manager.sh ssh

# Run a single command
./sandbox-manager.sh exec "node /home/testuser/cleo-source/packages/cleo/dist/cli/index.js version"

# View container logs
./sandbox-manager.sh logs

# Stop the container
./sandbox-manager.sh stop

# Destroy the container (keeps the image for fast restart)
./sandbox-manager.sh destroy

# Full cleanup (remove container and image)
./sandbox-manager.sh destroy
podman rmi cleo-sandbox:latest
```

## Manual Testing Inside the Container

```bash
./sandbox-manager.sh ssh

# Inside the container:
mkdir -p ~/test-project && cd ~/test-project
cleo init
cleo add "First task" --description "Testing sandbox"
cleo list
cleo session start --scope global --name "Test"
cleo start T001
cleo done T001 --skip-notes
cleo session end
```

## Next Steps

- See [README.md](README.md) for full command reference and troubleshooting
- See [TESTING-GUIDE.md](TESTING-GUIDE.md) for test suite details
