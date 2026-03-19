# CLEO Sandbox Status

## Container

- **Image**: Fedora latest with Node.js 20, npm, sqlite3, git, jq, openssh-server
- **SSH**: Port 2222 on localhost, ed25519 key-based auth
- **User**: `testuser` with passwordless sudo
- **Deploy**: `sandbox-manager.sh deploy` copies source, runs `npm install && npm run build`, symlinks CLI

## Test Runners

| Runner | Status | Assertions |
|--------|--------|------------|
| `adapter-test-runner.sh` | Operational | 97 across 12 suites |
| `test-runner.sh` | Operational | ~15 basic workflow |
| `simple-test.sh` | Operational | 6 smoke test |
| `test-docs-examples.sh` | Operational | 8 MCP API validation |
| `test-domain-operations.sh` | Operational | ~35 domain operations |
| `test-lifecycle-gates.sh` | Operational | ~10 lifecycle gates |

## Known Constraints

- SSH keys must be stored in `~/.cleo/sandbox/ssh/` (not in the project directory) due to FUSE filesystem permission limitations.
- `test-lifecycle-gates.sh` sources legacy Bash libraries (`lib/tasks/lifecycle.sh`) which are deprecated. This test may need migration to TypeScript/CLI-based assertions.
- `test-docs-examples.sh` and `test-domain-operations.sh` reference an MCP server path that must match the deployed layout.
