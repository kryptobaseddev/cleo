# CLEO Sandbox Testing Environment

Isolated Podman container for testing CLEO in a clean Fedora Linux environment with SSH access.

## Architecture

```
Host Machine
  sandbox-manager.sh ───────────────┐
                                     │ SSH (port 2222, key-based auth)
  ┌──────────────────────────────────┤
  │  Podman Container (cleo-sandbox) │
  │                                  │
  │  Fedora Linux + Node.js 20       │
  │  User: testuser (sudo access)    │
  │  sqlite3, git, jq, npm           │
  │                                  │
  │  ~/cleo-source/  (deployed CLEO) │
  └──────────────────────────────────┘
```

## Quick Start

```bash
cd /mnt/projects/claude-todo/dev/sandbox

# 1. Start the container (builds image on first run)
./sandbox-manager.sh start

# 2. Deploy CLEO source into the container (copies, installs deps, builds)
./sandbox-manager.sh deploy

# 3. Run tests
./adapter-test-runner.sh          # 97 assertions across 12 suites
./test-runner.sh                  # Basic workflow tests
```

## Commands

| Command | Description |
|---------|-------------|
| `./sandbox-manager.sh build` | Build the container image |
| `./sandbox-manager.sh start` | Start the container (builds if needed) |
| `./sandbox-manager.sh stop` | Stop the running container |
| `./sandbox-manager.sh destroy` | Remove the container (keeps image) |
| `./sandbox-manager.sh deploy` | Deploy CLEO source: copy, npm install, build, symlink |
| `./sandbox-manager.sh ssh` | Interactive SSH session |
| `./sandbox-manager.sh exec "cmd"` | Execute a command via SSH |
| `./sandbox-manager.sh status` | Show container, image, and SSH key status |
| `./sandbox-manager.sh logs [-f]` | View container logs (optionally follow) |

## Test Runners

### adapter-test-runner.sh (Comprehensive)

97 functional assertions across 12 test suites covering the adapter system, memory bridge, MCP resources, error handling, and end-to-end workflows.

```bash
./adapter-test-runner.sh              # Run all 12 suites
./adapter-test-runner.sh build        # Suite 1: Build & version
./adapter-test-runner.sh adapter      # Suite 2: Adapter discovery
./adapter-test-runner.sh bridge       # Suite 3: Memory bridge
./adapter-test-runner.sh resources    # Suite 4: MCP resources
./adapter-test-runner.sh errors       # Suite 5: Error catalog
./adapter-test-runner.sh contracts    # Suite 6: Contracts package
./adapter-test-runner.sh shared       # Suite 7: Shared package
./adapter-test-runner.sh session      # Suite 8: Session provider tracking
./adapter-test-runner.sh routing      # Suite 9: Skill routing table
./adapter-test-runner.sh cleanup      # Suite 10: Legacy cleanup verification
./adapter-test-runner.sh e2e          # Suite 11: E2E task workflow
./adapter-test-runner.sh errorpaths   # Suite 12: Error path validation
```

### test-runner.sh (Basic Workflow)

Tests fundamental CLEO operations: project init, task CRUD, sessions, multi-project isolation, error handling, and data persistence in SQLite.

```bash
./test-runner.sh                  # Run all scenarios
./test-runner.sh fresh            # Fresh installation
./test-runner.sh workflow         # Basic task workflow
./test-runner.sh multi            # Multi-project isolation
./test-runner.sh errors           # Error handling
./test-runner.sh persistence      # SQLite data persistence
```

### simple-test.sh

Minimal smoke test: creates a project, adds tasks, lists them, completes one.

### test-docs-examples.sh

Validates MCP server responses against documented API examples. Tests query/mutate operations across multiple domains.

### test-domain-operations.sh

Tests MCP operations across all domains via JSON-RPC, verifying response structure and envelope format.

### test-lifecycle-gates.sh

Tests lifecycle gate enforcement (RCASD-IVTR+C pipeline stages). Requires CLEO to be deployed in the sandbox first.

## SSH Keys

Generated automatically on first `start`. Stored in `~/.cleo/sandbox/ssh/` (not in the project directory, because the FUSE-mounted project filesystem does not support Unix permissions). The `ssh/` directory in this folder is gitignored as a fallback location.

## Container Details

- **Base**: Fedora latest
- **Packages**: Node.js 20, npm, sqlite3, git, jq, bash, openssh-server, sudo, vim, bats
- **User**: `testuser` (password: `testpass`, has passwordless sudo)
- **SSH**: Port 2222 on localhost only (127.0.0.1)
- **Image name**: `cleo-sandbox:latest`
- **Container name**: `cleo-sandbox`

## Deploy Workflow

`./sandbox-manager.sh deploy` does the following:

1. Creates a tarball of the project (excluding node_modules, dist, .git, databases)
2. Copies it into the container at `/home/testuser/cleo-source/`
3. Runs `npm install` and `npm run build` inside the container
4. Symlinks the built CLI to `/usr/local/bin/cleo`

## Troubleshooting

### Port 2222 already in use

```bash
sudo lsof -i :2222
SSH_PORT=2223 ./sandbox-manager.sh start
```

### SSH connection refused

```bash
./sandbox-manager.sh status         # Is the container running?
./sandbox-manager.sh logs | grep sshd
./sandbox-manager.sh stop && ./sandbox-manager.sh start
```

### SSH permission denied

```bash
chmod 600 ~/.cleo/sandbox/ssh/sandbox_key
chmod 644 ~/.cleo/sandbox/ssh/sandbox_key.pub
```

### Need a completely fresh environment

```bash
./sandbox-manager.sh destroy
podman rmi cleo-sandbox:latest
./sandbox-manager.sh start
./sandbox-manager.sh deploy
```

### Checking state inside the container

```bash
./sandbox-manager.sh ssh
# Inside:
cd ~/cleo-source
node packages/cleo/dist/cli/index.js version
sqlite3 .cleo/tasks.db "SELECT count(*) FROM tasks"
```

## File Listing

```
dev/sandbox/
├── Containerfile             # Fedora container image definition
├── sandbox-manager.sh        # Container lifecycle management
├── adapter-test-runner.sh    # 97-assertion comprehensive test suite
├── test-runner.sh            # Basic workflow test suite
├── simple-test.sh            # Minimal smoke test
├── test-docs-examples.sh     # MCP API documentation validation
├── test-domain-operations.sh # MCP domain operation tests
├── test-lifecycle-gates.sh   # Lifecycle gate enforcement tests
├── README.md                 # This file
├── QUICKSTART.md             # Focused quick-start guide
├── OVERVIEW.md               # Brief overview
├── TESTING-GUIDE.md          # Test runner details
├── STATUS.md                 # Current operational status
├── .gitignore                # Excludes SSH keys
└── ssh/                      # SSH keys (gitignored)
```
