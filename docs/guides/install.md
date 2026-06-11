# Installing CLEO

CLEO is the AI-native development orchestration platform by Cleocode.

## Requirements

- **Node.js >= 24.16.0** (required for SQLite 3.53.0+ WAL-reset support)
- **git** (required for worktree and version-control features)
- **npm** (ships with Node.js) or **pnpm**

## One-liner (macOS / Linux)

```sh
curl -fsSL https://raw.githubusercontent.com/kryptobaseddev/cleocode/main/scripts/install.sh | sh
```

The installer:
1. Detects your OS and architecture
2. Verifies Node.js >= 24.16.0 (prints install hints if missing)
3. Runs `npm install -g @cleocode/cleo`
4. Verifies `cleo --version`
5. On first install, hands off to `cleo` (the TUI setup wizard)

### Options

Pass options after `--` when piping, or as arguments when running locally:

```sh
# Preview what the installer would do — no changes made
sh scripts/install.sh --dry-run

# Auto-install Node via fnm if missing or too old
sh scripts/install.sh --with-node

# Use pnpm global install instead of npm
sh scripts/install.sh --pnpm

# Pin a specific version
sh scripts/install.sh --version 2026.5.126

# Skip the wizard hand-off (useful in CI)
sh scripts/install.sh --skip-wizard
```

## Windows (PowerShell)

Open PowerShell 5.1+ or PowerShell 7+ (as your user — no administrator required in most cases):

```powershell
iwr -useb https://raw.githubusercontent.com/kryptobaseddev/cleocode/main/scripts/install.ps1 | iex
```

Or run locally:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install.ps1 [options]
```

Options mirror the shell installer: `-DryRun`, `-WithNode`, `-UsePnpm`, `-SkipWizard`, `-Version`.

### Windows TUI support

- **Windows Terminal 1.11+** or **VS Code integrated terminal** — full TUI support
- **Legacy cmd.exe / ConHost** — best-effort (may show rendering artifacts)
- **WSL2 (Ubuntu)** — recommended for the richest experience (use the Linux one-liner above)

## npm / pnpm (direct — all platforms)

If you already have Node >= 24.16.0:

```sh
# npm
npm install -g @cleocode/cleo

# pnpm
pnpm add -g @cleocode/cleo

# Verify
cleo --version
```

## Upgrading

Re-run any of the above commands. The installer is idempotent — re-running upgrades in place.

## After installing

```sh
cleo          # open the TUI (first run launches the setup wizard)
cleo --help   # command reference
cleo login    # connect your Anthropic account
```

## Troubleshooting

### `cleo: command not found` after install

Your npm global bin directory is not in `PATH`. Find it:

```sh
npm bin -g
```

Add the output to your shell's `PATH` in `~/.bashrc` / `~/.zshrc`:

```sh
export PATH="$(npm bin -g):$PATH"
```

Open a new terminal and retry.

### Permission denied during install

Use a Node version manager to avoid permission issues entirely:

```sh
# fnm (all platforms, recommended)
curl -fsSL https://fnm.vercel.app/install | sh
fnm install 24.16.0
fnm use 24.16.0
# Then re-run the installer
```

Or fix the npm global prefix (permanent fix, no sudo):

```sh
mkdir -p "$HOME/.npm-global"
npm config set prefix "$HOME/.npm-global"
export PATH="$HOME/.npm-global/bin:$PATH"   # add to ~/.bashrc or ~/.zshrc
```

### Node version too old

```sh
node --version   # must be >= 24.16.0
```

Use fnm, nvm, or your platform package manager to upgrade.

---

> **Note**: This installer NEVER enables or starts the systemd daemon.
> Daemon lifecycle is managed by the CLEO postinstall hook per internal policy.
