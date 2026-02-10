# MCP Registry Submission Guide

**Server**: CLEO MCP Server
**Package**: `@cleocode/mcp-server`
**Registry Name**: `io.github.kryptobaseddev/cleo-mcp-server`

## Overview

The MCP Registry at `registry.modelcontextprotocol.io` is the official directory for MCP servers. Submission uses the `mcp-publisher` CLI tool with GitHub authentication. The registry stores metadata only (not package artifacts) -- the npm package remains on npmjs.org.

## Prerequisites

Before submitting, ensure:

1. **npm package is published**: `@cleocode/mcp-server` must be live on npmjs.org
2. **GitHub account**: Must own `kryptobaseddev` GitHub account (for `io.github.kryptobaseddev/*` namespace)
3. **`mcpName` in package.json**: Must match the `name` field in `server.json`

## Step-by-Step Submission

### Step 1: Add `mcpName` to package.json

Add this field to `mcp-server/package.json`:

```json
{
  "mcpName": "io.github.kryptobaseddev/cleo-mcp-server"
}
```

Then republish the npm package so the registry can verify ownership:

```bash
cd mcp-server
npm version patch
npm publish --access public
```

### Step 2: Verify server.json

The `server.json` file has been created at `mcp-server/server.json`. Review it and ensure:

- `name` matches the `mcpName` in package.json
- `version` matches the current npm package version
- `packages[0].version` matches the current npm package version
- `repository.url` points to the correct GitHub repo

### Step 3: Install mcp-publisher CLI

> **Note**: `mcp-publisher` is a Go binary from the MCP Registry team. It is used
> ONLY for publishing metadata to the registry -- it is NOT the CLEO MCP server
> itself (which is the cross-platform npm package `@cleocode/mcp-server`).

**macOS / Linux** (auto-detects OS and architecture):

```bash
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)
case "$ARCH" in
  x86_64)        ARCH="amd64" ;;
  aarch64|arm64) ARCH="arm64" ;;
esac
curl -fL "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_${OS}_${ARCH}.tar.gz" | tar xz
sudo mv mcp-publisher /usr/local/bin/
```

**macOS via Homebrew**:

```bash
brew install mcp-publisher
```

**Windows** (PowerShell):

```powershell
$arch = if ([System.Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture -eq "Arm64") { "arm64" } else { "amd64" }
Invoke-WebRequest -Uri "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_windows_${arch}.tar.gz" -OutFile "mcp-publisher.tar.gz"
tar xf mcp-publisher.tar.gz mcp-publisher.exe
Remove-Item mcp-publisher.tar.gz
# Move mcp-publisher.exe to a directory in your PATH
```

> **Windows alternative**: Use WSL (Windows Subsystem for Linux) and follow the
> macOS/Linux instructions above.

### Step 4: Authenticate with GitHub

```bash
cd mcp-server
mcp-publisher login github
```

This opens a device code flow:
1. A code is displayed in your terminal
2. Open https://github.com/login/device in your browser
3. Enter the code and authorize the MCP Registry application
4. Terminal confirms: "Successfully authenticated!"

### Step 5: Publish to Registry

```bash
cd mcp-server
mcp-publisher publish
```

### Step 6: Verify Registration

```bash
curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.kryptobaseddev/cleo-mcp-server"
```

Or visit `https://registry.modelcontextprotocol.io` and search for "cleo".

## Automated Publishing via GitHub Actions

For automated registry updates on new releases, add this workflow:

Create `.github/workflows/publish-mcp-registry.yml`:

```yaml
name: Publish to MCP Registry

on:
  push:
    tags:
      - 'v*'

permissions:
  id-token: write
  contents: read

jobs:
  publish-registry:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Download mcp-publisher
        # Auto-detect OS/arch for cross-platform runner support
        run: |
          OS=$(uname -s | tr '[:upper:]' '[:lower:]')
          ARCH=$(uname -m)
          case "$ARCH" in
            x86_64)  ARCH="amd64" ;;
            aarch64|arm64) ARCH="arm64" ;;
          esac
          curl -fL "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_${OS}_${ARCH}.tar.gz" | tar xz
          chmod +x mcp-publisher

      - name: Authenticate (GitHub OIDC)
        run: ./mcp-publisher login github-oidc

      - name: Publish to MCP Registry
        working-directory: mcp-server
        run: ../mcp-publisher publish
```

This uses GitHub OIDC (no secrets needed) to authenticate and publish automatically when a version tag is pushed.

## Files Reference

| File | Purpose |
|------|---------|
| `mcp-server/server.json` | Registry metadata (required) |
| `mcp-server/package.json` | Must contain `mcpName` field |
| `.github/workflows/publish-mcp-registry.yml` | Automated CI publishing |

## Namespace Rules

- GitHub auth requires `io.github.<username>/*` namespace
- The `mcpName` in package.json MUST match `name` in server.json
- The npm package `@cleocode/mcp-server` identifier is separate from the registry name

## Troubleshooting

| Error | Cause | Fix |
|-------|-------|-----|
| "Registry validation failed" | Missing `mcpName` in package.json | Add `mcpName` field and republish to npm |
| "Invalid or expired JWT token" | Auth expired | Re-run `mcp-publisher login github` |
| "No permission" | Namespace mismatch | Ensure server name starts with `io.github.kryptobaseddev/` |
| "Package not found" | npm package not published | Run `npm publish --access public` first |

## Important Notes

- The registry is in **preview** (launched September 2025). Breaking changes may occur.
- The registry is a **metaregistry** -- it stores metadata, not package code.
- Only trusted public registries are allowed (npmjs.org for npm packages).
- Publisher-provided metadata in `_meta` is limited to 4KB.
- Version in server.json should be updated with each npm publish.

## Links

- MCP Registry: https://registry.modelcontextprotocol.io
- Registry GitHub: https://github.com/modelcontextprotocol/registry
- Registry Docs: https://github.com/modelcontextprotocol/registry/tree/main/docs
- server.json Schema: https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json
- MCP Specification: https://modelcontextprotocol.io/specification
