# install.ps1 — CLEO one-line installer for Windows (PowerShell 5.1+ or PowerShell 7+)
#
# Usage (one-liner from an elevated or user PowerShell terminal):
#   iwr -useb https://raw.githubusercontent.com/kryptobaseddev/cleocode/main/scripts/install.ps1 | iex
#
# Local invocation:
#   powershell -ExecutionPolicy Bypass -File scripts\install.ps1 [options]
#
# Options:
#   -DryRun        Print what would happen without making any changes
#   -WithNode      Auto-install Node via winget or choco if missing/too old
#   -UsePnpm       Use pnpm global install instead of npm
#   -SkipWizard    Do not launch cleo after install (useful in CI)
#   -Version VER   Install a specific @cleocode/cleo version (default: latest)
#
# Supported: Windows 10/11, PowerShell 5.1+, PowerShell 7+
# Required:  Node.js >= 24.16.0
#   SSoT: root package.json engines.node  (scripts/lint-installer-node-floor.mjs)
#
# Windows support level:
#   - Core CLEO CLI: FULL support
#   - TUI (pi-tui): BEST-EFFORT — the pi-tui interactive terminal requires a
#     VT100-capable terminal (Windows Terminal 1.11+ or VS Code integrated
#     terminal). Legacy cmd.exe / ConHost may show rendering artifacts.
#     WSL2 (Ubuntu) is recommended for the richest TUI experience.
#   - Native modules (Rust/NAPI): pre-built binaries for win32-x64 are
#     published; arm64 Windows is not currently tested.
#   - Daemon (cleo daemon): runs as a standard Windows process; no service
#     registration is done by this installer (postinstall handles policy).
#
# @task T11981
# @epic T11671 E6-ONBOARDING

[CmdletBinding()]
param(
    [switch]$DryRun,
    [switch]$WithNode,
    [switch]$UsePnpm,
    [switch]$SkipWizard,
    [string]$Version = 'latest'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ── SSoT: Node floor ─────────────────────────────────────────────────────────
# MUST match root package.json engines.node.
# CI guard: scripts/lint-installer-node-floor.mjs enforces parity.
$NODE_FLOOR_MAJOR = 24
$NODE_FLOOR_MINOR = 16
$NODE_FLOOR_PATCH = 0
$NODE_FLOOR = "$NODE_FLOOR_MAJOR.$NODE_FLOOR_MINOR.$NODE_FLOOR_PATCH"

$PACKAGE = '@cleocode/cleo'

# ── Helpers ──────────────────────────────────────────────────────────────────
function Write-Info    { param([string]$Msg) Write-Host "[cleo-install] $Msg" -ForegroundColor Green }
function Write-Warn    { param([string]$Msg) Write-Warning "[cleo-install] $Msg" }
function Write-Err     { param([string]$Msg) Write-Host "[cleo-install] ERROR: $Msg" -ForegroundColor Red }
function Write-Section { param([string]$Msg) Write-Host "`n==> $Msg" -ForegroundColor Cyan }
function Write-Dry     { param([string]$Msg) Write-Host "[dry-run] $Msg" -ForegroundColor DarkCyan }

function Invoke-Step {
    param([string]$Description, [scriptblock]$Action)
    if ($DryRun) {
        Write-Dry "Would run: $Description"
    } else {
        & $Action
    }
}

# ── Platform check ───────────────────────────────────────────────────────────
Write-Section "Detecting platform"
$OS = [System.Environment]::OSVersion
$Arch = [System.Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture
Write-Info "OS: $($OS.VersionString)"
Write-Info "Arch: $Arch"

if ($Arch -ne 'X64' -and $Arch -ne 'Arm64') {
    Write-Warn "Unsupported architecture ($Arch) — native modules may not be available."
}

# ── Node.js version check ─────────────────────────────────────────────────────
Write-Section "Checking Node.js (required: >=$NODE_FLOOR)"

function Test-NodeOk {
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { return $false }
    try {
        $raw = (node --version 2>&1).ToString().TrimStart('v')
        $parts = $raw -split '\.'
        $major = [int]$parts[0]
        $minor = [int]$parts[1]
        $patch = [int]($parts[2] -replace '[^0-9].*', '')
        if ($major -gt $NODE_FLOOR_MAJOR) { return $true }
        if ($major -eq $NODE_FLOOR_MAJOR -and $minor -gt $NODE_FLOOR_MINOR) { return $true }
        if ($major -eq $NODE_FLOOR_MAJOR -and $minor -eq $NODE_FLOOR_MINOR -and $patch -ge $NODE_FLOOR_PATCH) { return $true }
        return $false
    } catch {
        return $false
    }
}

if (Test-NodeOk) {
    $nodeVer = (node --version 2>&1)
    Write-Info "Node.js $nodeVer — OK (>=$NODE_FLOOR required)"
} else {
    $foundNode = if (Get-Command node -ErrorAction SilentlyContinue) { (node --version 2>&1) } else { 'not found' }
    Write-Warn "Node.js $foundNode does not meet the minimum requirement (>=$NODE_FLOOR)."
    Write-Warn ""
    Write-Warn "The Node floor is $NODE_FLOOR (requires SQLite 3.53.0+ for WAL-reset fix)."
    Write-Warn ""

    if ($WithNode) {
        Write-Section "Installing Node.js (--WithNode)"
        $installed = $false

        # Try winget first (built into Windows 10 1709+ and Windows 11)
        if (Get-Command winget -ErrorAction SilentlyContinue) {
            Write-Info "Using winget to install Node.js $NODE_FLOOR_MAJOR LTS..."
            Invoke-Step "winget install OpenJS.NodeJS.LTS" {
                winget install --id OpenJS.NodeJS.LTS --silent --accept-source-agreements --accept-package-agreements
            }
            $installed = $true
        # Try chocolatey if winget not available
        } elseif (Get-Command choco -ErrorAction SilentlyContinue) {
            Write-Info "Using chocolatey to install Node.js..."
            Invoke-Step "choco install nodejs-lts -y" {
                choco install nodejs-lts --yes
            }
            $installed = $true
        } else {
            Write-Err "Neither winget nor chocolatey is available."
            Write-Err "Please install Node.js >= $NODE_FLOOR manually:"
            Write-Err "  https://nodejs.org/en/download"
            Write-Err ""
            Write-Err "Or install via winget:"
            Write-Err "  winget install OpenJS.NodeJS.LTS"
            Write-Err ""
            Write-Err "Or install chocolatey first (https://chocolatey.org/install):"
            Write-Err "  choco install nodejs-lts -y"
            exit 1
        }

        if ($installed -and -not $DryRun) {
            # Refresh PATH for this session
            $env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
                        [System.Environment]::GetEnvironmentVariable('Path', 'User')
            if (-not (Test-NodeOk)) {
                Write-Err "Node installation completed but version check still fails."
                Write-Err "Please open a new terminal and re-run this installer."
                exit 1
            }
            Write-Info "Node.js installed successfully."
        }
    } else {
        Write-Err "Please install Node.js >= $NODE_FLOOR before running this installer."
        Write-Err ""
        Write-Err "Recommended options:"
        Write-Err "  winget install OpenJS.NodeJS.LTS"
        Write-Err "  OR"
        Write-Err "  choco install nodejs-lts -y"
        Write-Err "  OR"
        Write-Err "  Download from https://nodejs.org/en/download"
        Write-Err ""
        Write-Err "Re-run with -WithNode to auto-install via winget/choco:"
        Write-Err "  powershell -File scripts\install.ps1 -WithNode"
        exit 1
    }
}

# ── git check ────────────────────────────────────────────────────────────────
Write-Section "Checking git"
if (Get-Command git -ErrorAction SilentlyContinue) {
    $gitVer = (git --version 2>&1)
    Write-Info "$gitVer — OK"
} else {
    Write-Warn "git not found. CLEO worktree and version-control features require git."
    Write-Warn "Install via:  winget install Git.Git"
    Write-Warn "              OR https://git-scm.com/download/win"
    Write-Warn "Proceeding — CLEO core will install but some features will be unavailable."
}

# ── Package manager selection ────────────────────────────────────────────────
Write-Section "Selecting package manager"

$pmCmd = 'npm'
$pmInstallArgs = @('install', '-g')

if ($UsePnpm) {
    if (Get-Command pnpm -ErrorAction SilentlyContinue) {
        $pmCmd = 'pnpm'
        $pmInstallArgs = @('add', '-g')
        Write-Info "Using pnpm (-UsePnpm flag set)"
    } else {
        Write-Warn "pnpm not found — falling back to npm"
    }
}

if ($pmCmd -eq 'npm') {
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
        Write-Err "npm not found. npm ships with Node.js — your Node installation may be broken."
        exit 1
    }
    Write-Info "Using npm $((npm --version 2>&1))"
}

# ── Detect existing install ──────────────────────────────────────────────────
Write-Section "Checking for existing CLEO install"
$firstInstall = $true
if (Get-Command cleo -ErrorAction SilentlyContinue) {
    $existingVer = (cleo --version 2>&1)
    Write-Info "Found existing cleo $existingVer — will upgrade"
    $firstInstall = $false
} else {
    Write-Info "No existing cleo install detected — fresh install"
}

# ── Install / upgrade ────────────────────────────────────────────────────────
Write-Section "Installing $PACKAGE"

$installSpec = if ($Version -eq 'latest') { $PACKAGE } else { "${PACKAGE}@${Version}" }
Write-Info "Running: $pmCmd $($pmInstallArgs -join ' ') $installSpec"

if ($DryRun) {
    Write-Dry "Would run: $pmCmd $($pmInstallArgs -join ' ') $installSpec"
} else {
    try {
        & $pmCmd @pmInstallArgs $installSpec
        if ($LASTEXITCODE -ne 0) { throw "Install exited with code $LASTEXITCODE" }
    } catch {
        Write-Err "Install failed: $_"
        Write-Err ""
        Write-Err "If this is a permissions error, try running PowerShell as Administrator."
        Write-Err "Or use a Node version manager (nvm-windows, fnm) to avoid permission issues:"
        Write-Err "  winget install schniz.fnm"
        Write-Err "  fnm install $NODE_FLOOR"
        Write-Err "  fnm use $NODE_FLOOR"
        exit 1
    }
}

# ── Verify install ───────────────────────────────────────────────────────────
Write-Section "Verifying install"
if ($DryRun) {
    Write-Dry "Would run: cleo --version"
} else {
    # Refresh PATH in case the global bin dir was just added
    $env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
                [System.Environment]::GetEnvironmentVariable('Path', 'User')

    if (-not (Get-Command cleo -ErrorAction SilentlyContinue)) {
        Write-Err "cleo not found in PATH after install."
        Write-Err ""
        Write-Err "Your npm global bin directory may not be in PATH."
        Write-Err "Find it with:  npm bin -g"
        Write-Err "Then add it to your user PATH environment variable."
        Write-Err ""
        Write-Err "Open a new PowerShell window and try: cleo --version"
        exit 1
    }
    $installedVer = (cleo --version 2>&1)
    Write-Info "cleo $installedVer installed successfully."
}

# ── Windows TUI compatibility note ───────────────────────────────────────────
Write-Host ""
Write-Host "NOTE: Windows terminal compatibility" -ForegroundColor Yellow
Write-Host "  For the best TUI experience, use Windows Terminal (winget install Microsoft.WindowsTerminal)" -ForegroundColor Yellow
Write-Host "  or VS Code's integrated terminal. Legacy cmd.exe may show rendering artifacts." -ForegroundColor Yellow
Write-Host "  WSL2 (Ubuntu) is recommended for native Linux-equivalent support." -ForegroundColor Yellow

# ── First-install wizard hand-off ────────────────────────────────────────────
if ($firstInstall -and -not $SkipWizard) {
    Write-Section "First install — starting setup wizard"
    $configFile = Join-Path $env:APPDATA 'cleo\config.json'
    # Also check XDG_CONFIG_HOME on Windows (some tools set it)
    $xdgConfig = $env:XDG_CONFIG_HOME
    if ($xdgConfig) {
        $configFile = Join-Path $xdgConfig 'cleo\config.json'
    }

    if ($DryRun) {
        Write-Dry "Would check: $configFile exists"
        Write-Dry "Would run: cleo  (opens TUI / wizard)"
    } elseif (-not (Test-Path $configFile)) {
        Write-Info "No config found at $configFile — launching setup wizard..."
        Write-Info ""
        Write-Info "  Run:  cleo"
        Write-Info ""
        Write-Info "The wizard will guide you through:"
        Write-Info "  * Connecting your Anthropic account (or API key)"
        Write-Info "  * Setting up your first project"
        Write-Info "  * Configuring CLEO for your workflow"
        Write-Info ""

        # Only auto-launch in interactive sessions
        $isCI = $env:CI -or $env:GITHUB_ACTIONS -or $env:TF_BUILD
        if ([Environment]::UserInteractive -and -not $isCI) {
            cleo
        } else {
            Write-Info "(Non-interactive environment detected — skipping auto-launch)"
            Write-Info "Run 'cleo' manually to start the setup wizard."
        }
    }
} elseif (-not $firstInstall -and -not $DryRun) {
    Write-Info "Upgrade complete. Run 'cleo' to open the TUI or 'cleo --help' to see commands."
}

# ── Summary ──────────────────────────────────────────────────────────────────
Write-Section "Done"
if ($DryRun) {
    Write-Dry "Dry run complete — no changes were made."
    Write-Dry ""
    Write-Dry "Summary of what WOULD happen:"
    Write-Dry "  Node req:  >= $NODE_FLOOR"
    Write-Dry "  Install:   $pmCmd $($pmInstallArgs -join ' ') $installSpec"
    Write-Dry "  Verify:    cleo --version"
} else {
    Write-Info "CLEO installed. Get started:"
    Write-Info "  cleo              open TUI"
    Write-Info "  cleo --help       command reference"
    Write-Info "  cleo login        connect your account"
}
