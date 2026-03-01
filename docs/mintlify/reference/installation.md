# CLEO Installation Reference

## Quick Install

```bash
npm install -g @cleocode/cleo
```

Requires **Node.js 24+**. Verify with `node --version`.

## Prerequisites

| Requirement | Version | Check Command |
|-------------|---------|---------------|
| Node.js | 24+ (LTS) | `node --version` |
| npm | 10+ (included) | `npm --version` |
| OS | Linux, macOS, WSL2 | - |

No additional dependencies (jq, flock, etc.) are required.

## Installation Methods

### npm Global (Recommended)

```bash
npm install -g @cleocode/cleo
cleo version    # Verify installation
```

### MCP-Only (No Global Install)

```json
{
  "mcpServers": {
    "cleo": {
      "command": "npx",
      "args": ["-y", "@cleocode/cleo@latest", "mcp"]
    }
  }
}
```

### From Source (Contributors)

```bash
git clone https://github.com/kryptobaseddev/cleo.git
cd cleo
npm install
npm run build
npm link
```

## Project Initialization

```bash
cd /path/to/your/project
cleo init
```

### What Gets Created

```
your-project/
└── .cleo/
    ├── tasks.db              # SQLite database (tasks, sessions, audit log)
    ├── config.json           # Project configuration (human-editable)
    ├── project-info.json     # Project metadata
    ├── project-context.json  # Detected project type (with --detect)
    ├── schemas/              # JSON Schema definitions
    └── .gitignore            # Selective git tracking
```

CLEO automatically injects task management instructions into `CLAUDE.md`, `AGENTS.md`, and `GEMINI.md`.

### Init Options

| Flag | Purpose |
|------|---------|
| `--detect` | Auto-detect project type, framework, test runner |
| `--update-docs` | Refresh agent doc injections only |
| `--copy-agents` | Install agent definitions as copies (not symlinks) |
| `--force --confirm-wipe` | Destructive reinitialize (creates safety backup) |

## Updating

```bash
npm update -g @cleocode/cleo
```

After updating, run `cleo init --update-docs` in each project to refresh agent documentation.

## Verification

```bash
cleo version      # Check installed version
cleo validate     # Verify project data integrity
cleo doctor       # Run full system diagnostics
```

## Uninstallation

```bash
# Remove global installation
npm uninstall -g @cleocode/cleo

# Remove per-project data (optional, per project)
rm -rf .cleo/
```

## Troubleshooting

### Command Not Found

Ensure npm's global bin directory is in your PATH:

```bash
npm config get prefix    # Find npm global prefix
export PATH="$(npm config get prefix)/bin:$PATH"
```

### Node.js Version Too Old

```bash
node --version    # Must be 24+
nvm install 24    # If using nvm
```

### Permission Denied

```bash
npm config set prefix ~/.npm-global
export PATH="$HOME/.npm-global/bin:$PATH"
```

## See Also

- [Installation Guide](/getting-started/installation) - Detailed walkthrough
- [Installation Modes](/guides/INSTALLATION-MODES) - npm vs npx vs source
- [MCP Server Setup](/getting-started/mcp-server) - MCP configuration
- [Quick Start](/getting-started/quickstart) - First steps after install
