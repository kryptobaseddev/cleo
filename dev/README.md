# Development Tools

Development scripts for CLEO contributors. **Not shipped to users.**

## Dev Workflow

```bash
# Canonical isolated dev install
./install.sh --dev

# Edit source in src/
# Rebuild after changes (or use watch)
npm run build

# Or auto-rebuild on file change
npm run dev:watch

# Type-check without emitting
npm run build:check

# Run tests
npm test

# Verify dev-channel runtime identity
cleo-dev env info --json

# Switch back to production release
bash dev/teardown-dev.sh --production
```

## Dev Mode vs Production

| Aspect | Dev Mode | Production |
|--------|----------|------------|
| Install | `./install.sh --dev` (channel-aware) | `npm install -g @cleocode/cleo` |
| Binary names | `cleo-dev`, `cleo-mcp-dev` | `cleo`, `cleo-mcp`, `ct` |
| Binary resolution | `installer/lib/link.sh` mode mapping | npm global `node_modules/` |
| Rebuild | `npm run build` or `dev:watch` | N/A (pre-built) |
| VERSION marker | `mode=dev-*` | `mode=production` |

Dev mode is intentionally isolated from stable runtime behavior.

### Important `npm link` caveat

Raw `npm link` follows package `bin` mappings and may expose `cleo`/`ct` names.
Use `./install.sh --dev` when you need strict dev-channel identity (`cleo-dev`) and
parallel-safe behavior with stable installs.

## Scripts

### Active

| Script | Purpose |
|--------|---------|
| `setup-ts-dev.sh` | Legacy dev bootstrap via `npm link` (`npm run dev:setup`, non-isolated names) |
| `teardown-dev.sh` | Remove dev mode, optionally install production |
| `validate-version.sh` | Verify version consistency across repo files |
| `generate-command-docs.sh` | Generate Mintlify MDX docs from COMMANDS-INDEX.json |
| `generate-features.sh` | Generate FEATURES.md from FEATURES.json |
| `generate-protocol-docs.sh` | Generate Mintlify MDX from protocol markdown |

### Directories

| Directory | Purpose |
|-----------|---------|
| `hooks/` | Git hooks for the repo |
| `migrations/` | TypeScript data migration scripts |
| `sandbox/` | Experimental scratch space |
| `skills/` | Dev-only skills |
| `archived/` | Legacy bash-era scripts (preserved for reference) |

## Archived Scripts

The `archived/` directory contains scripts from the pre-TypeScript bash era.
They are preserved for historical reference but are **not used** by the current
TypeScript system. See git history for their original documentation.

## Note

These scripts are excluded from `install.sh` and the npm package (`files` field
in package.json does not include `dev/`).
