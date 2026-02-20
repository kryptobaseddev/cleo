# Development Tools

Development scripts for CLEO contributors. **Not shipped to users.**

## Dev Workflow

```bash
# Initial setup (builds + npm link)
npm run dev:setup

# Edit source in src/
# Rebuild after changes
npm run build

# Or auto-rebuild on file change
npm run dev:watch

# Type-check without emitting
npm run build:check

# Run tests
npm test

# Switch back to production release
bash dev/teardown-dev.sh --production
```

## Dev Mode vs Production

| Aspect | Dev Mode | Production |
|--------|----------|------------|
| Install | `npm run dev:setup` | `npm install -g @cleocode/cleo` |
| Binary resolution | `npm link` -> repo `dist/` | npm global `node_modules/` |
| Binary path | Same as production (`npm global bin`) | `npm global bin` |
| Rebuild | `npm run build` or `dev:watch` | N/A (pre-built) |
| VERSION marker | `mode=dev` | `mode=production` |

Dev mode uses `npm link` to create the same symlinks that `npm install -g` would,
ensuring the binary resolution path matches production exactly.

## Scripts

### Active

| Script | Purpose |
|--------|---------|
| `setup-ts-dev.sh` | Set up dev mode via `npm link` (`npm run dev:setup`) |
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
