# ADR-016: Installation Channels and Dev Runtime Isolation

**Date**: 2026-02-25
**Status**: accepted
**Accepted**: 2026-02-25
**Related Tasks**: T4881, T4882, T4883, T4884, T4885, T4886, T4887, T4888, T5063, T5242
**Related ADRs**: ADR-008, ADR-011, ADR-012, ADR-015
**Summary**: Defines three CLEO installation channels (npm global with auto-bootstrap, npm local, dev symlink), establishes runtime isolation between dev and production instances, separates global system setup from project initialization, and specifies the CI/CD release pipeline with CalVer enforcement and OIDC trusted publishing.
**Keywords**: installation, channels, npm, global, local, dev, symlink, runtime-isolation, npm-link, calver, oidc, trusted-publishing, release, ci-cd
**Topics**: admin, tools, security, release

---

## 1. Context

CLEO currently has channel ambiguity between source code, globally installed npm package binaries, and provider MCP configurations. This ambiguity causes dogfooding failures where contributors edit source but execute an older global binary.

Additionally, the original architecture conflated global system setup with project-level initialization, requiring users to run manual bootstrap commands after npm install.

We need a canonical channel model that supports three modes without collisions, with clear separation of concerns:

1. **Production stable installs** for end users — auto-bootstrap global system via npm postinstall
2. **Beta prerelease installs** for early adopters — same auto-bootstrap, different dist-tag
3. **Contributor-local dev runtime** in parallel with stable installs — symlink-based, isolated data

**Key architectural decisions made in T5242 (v2026.3.11):**
- Global CLEO system setup (`~/.cleo/`, MCP configs, templates) now happens automatically via npm `postinstall` hook
- `cleo init` creates **only** local project structure (`./.cleo/`, NEXUS registration), no longer touches global configs
- `install.sh` is now **dev-mode/legacy-only** for contributors and offline/air-gapped systems
- Dev channel uses real symlinks in `~/.local/bin/`, not shell aliases

Provider-specific MCP config management is delegated to CAAMP.

---

## 2. Decision

CLEO SHALL standardize on three runtime channels:

### 2.1 Stable Channel (`stable`)

- Package source: `@cleocode/cleo@latest`
- Installation: `npm i -g @cleocode/cleo`
- **Auto-bootstrap**: npm `postinstall` hook automatically sets up global CLEO system
- MCP runtime command: `cleo mcp` (or `npx -y @cleocode/cleo@latest mcp`)
- Default MCP server name: `cleo`
- Default data root: `~/.cleo`
- Project init: `cleo init` (creates only local `./.cleo/`)

### 2.2 Beta Channel (`beta`)

- Package source: `@cleocode/cleo@beta` (or exact `x.y.z-beta.n`)
- Installation: `npm i -g @cleocode/cleo@beta`
- **Auto-bootstrap**: Same postinstall hook as stable
- MCP runtime command: `cleo-beta mcp` (or `npx -y @cleocode/cleo@beta mcp`)
- Recommended MCP server name: `cleo-beta`
- Default data root: `~/.cleo` unless explicitly isolated

### 2.3 Contributor Dev Channel (`dev`)

- Runtime source: local repository build output
- CLI command: `cleo-dev` (symlink in `~/.local/bin/`)
- MCP server name: `cleo-dev`
- Default dev data root: `~/.cleo-dev`
- Dev runtime MUST NOT overwrite stable global `cleo` unless explicitly requested
- Dev runtime MUST NOT create `ct` symlink
- Dev runtime MUST NOT create `cleo` symlink by default
- **Installation**: `./install.sh --dev` (NOT `npm link`)

---

## 3. Channel Isolation Rules

1. Binary identity, MCP server name, and data root SHALL be treated as separate concerns.
2. `dev` runtime SHALL default to isolated data storage (`~/.cleo-dev`).
3. `dev` runtime SHALL expose only `cleo-dev` command surface; legacy `ct` alias is excluded.
4. **Global system setup SHALL be separated from project initialization**:
   - `npm install -g @cleocode/cleo` bootstraps global system via `postinstall` hook
   - `cleo init` creates ONLY local project structure (`./.cleo/`, NEXUS registration)
   - `install.sh` is dev-mode/legacy-only and SHALL NOT be the primary user installation method
5. Installer link creation SHALL be centralized in `installer/lib/link.sh` with channel-aware mapping.
6. Duplicate ad-hoc symlink logic in other installer entry points SHOULD be removed.
7. Provider MCP profiles SHALL be installed and managed by CAAMP (not by ad-hoc manual snippets in CLEO docs).
8. CLEO docs SHALL publish channel contract semantics, while CAAMP docs/commands SHALL publish provider-specific configuration details.
9. Archived/dev-only scripts MUST NOT be referenced by production install paths.

---

## 4. Rationale

- Prevents source-vs-runtime confusion for contributors.
- Enables side-by-side stable/beta/dev usage with clear rollback.
- Keeps provider integration logic centralized in CAAMP, which already owns provider config surface area and APIs.
- Preserves low-friction stable installation for end users.

---

## 5. Consequences

### Positive

- Deterministic channel behavior for support and troubleshooting
- Reduced dogfooding regressions caused by wrong binary execution
- Clean separation of responsibilities between CLEO and CAAMP

### Tradeoffs

- Slightly more onboarding detail for contributors
- Additional CI/test matrix surface for channel verification

---

## 6. Implementation Scope

- CLEO: channel contract docs, dev runtime guidance, channel-aware diagnostics
- CAAMP: provider install/uninstall/update flows for `stable|beta|dev`, plus TUI and non-interactive CLI/API controls

## 7. Installation Architecture

### 7.1 Primary Installation Method (npm)

**For all users (stable/beta channels):**

```bash
npm install -g @cleocode/cleo
```

The npm package includes a `postinstall` script (`bin/postinstall.js`) that automatically bootstraps the global CLEO system:

1. Creates `~/.cleo/` directory structure
2. Installs global templates (`CLEO-INJECTION.md`)
3. Detects AI providers and installs MCP server configs via CAAMP
4. Creates `~/.agents/AGENTS.md` hub

**Benefits:**
- Single-command installation
- No manual bootstrap steps required
- Automatic global setup on every npm install/upgrade

### 7.2 Project Initialization

After global installation, users run:

```bash
cd /path/to/project
cleo init
```

This creates **only** local project structure:
- `./.cleo/` directory with `config.json` and `tasks.db`
- NEXUS project registration
- Git hooks (commit-msg, pre-commit)
- CAAMP injection into local `AGENTS.md`

**Explicitly does NOT:**
- Modify global MCP configs (done by postinstall)
- Install global templates (done by postinstall)
- Touch `~/.cleo/` beyond project registration

### 7.3 Dev Mode Installation (Contributors)

For CLEO contributors requiring isolated development:

```bash
git clone https://github.com/kryptobaseddev/cleo.git
cd cleo
./install.sh --dev
```

This creates:
- `cleo-dev` symlink in `~/.local/bin/`
- Isolated data root at `~/.cleo-dev/`
- No interference with stable `cleo` installation

> **Important**: `install.sh` is now **dev-mode/legacy-only**. It SHALL NOT be the primary installation method for end users. The bash installer remains available for:
> - Contributors setting up dev environment
> - Offline/air-gapped systems without npm access
> - Users who prefer bash over npm

### 7.4 Mode-aware command/link mapping

- `stable`: `cleo`, `ct` (compat), server `cleo` — MCP via `cleo mcp`
- `beta`: `cleo-beta`, optional `ct-beta`, server `cleo-beta` — MCP via `cleo-beta mcp`
- `dev`: `cleo-dev` (symlink), server `cleo-dev`, no `ct` — MCP via `cleo-dev mcp`

> **Note**: As of v2026.2.9, standalone `cleo-mcp` binaries are removed. MCP servers are launched via the `cleo mcp` pseudo-subcommand (see commit `6c955628`).

### 7.5 Production-path script policy

- Production installer MUST NOT reference scripts under `/dev` or `/dev/archived`.
- Existing `setup-claude-aliases` behavior is removed from CLEO installer flow and delegated to CAAMP as optional utility tooling.

### 7.6 npm bin caveat

`package.json` may expose compatibility bins (`ct`) for package installs. Channel-aware installer behavior still defines which links are created per mode, and `dev` mode excludes `ct`.

### 7.7 Contributor `npm link` caveat

- Raw `npm link` uses package `bin` mappings and can expose `cleo`/`ct` names.
- Contributors requiring strict dev isolation MUST use the channel-aware installer dev flow (`./install.sh --dev`) so `cleo-dev` / `cleo-mcp-dev` are configured.
- Diagnostics (`cleo env info` / `admin.runtime`) SHOULD warn when dev channel is invoked via `cleo` instead of `cleo-dev`.

---

## 8. Release Pipeline

### 8.1 Versioning Scheme

CLEO uses **Calendar Versioning (CalVer)** with format `YYYY.M.PATCH`:

- `YYYY` — four-digit year
- `M` — month (no leading zero)
- `PATCH` — sequential patch number within the month, starting at 0

Pre-release suffixes follow semver conventions appended to the CalVer base:

- `-alpha.N` — early development, unstable
- `-dev.N` — development snapshots
- `-beta.N` — feature-complete, testing
- `-rc.N` — release candidate

### 8.2 CalVer Enforcement

The CI pipeline SHALL reject any release where the tag's year and month do not match the current UTC date. This prevents publishing future-dated or back-dated versions.

- `v2026.2.8` pushed in February 2026 — allowed
- `v2026.3.0` pushed in February 2026 — **rejected**
- `v2026.2.8-rc.1` pushed in February 2026 — allowed (CalVer validates `YYYY.M` prefix only)

### 8.3 Workflow Architecture

The release pipeline uses a single-workflow design in `.github/workflows/release.yml` with one consolidated "Build & Publish" job. All steps execute sequentially in a single job — the project is built once and all publishing follows.

```
git tag vYYYY.M.PATCH → git push origin vYYYY.M.PATCH
    ↓
release.yml (triggered by tag push matching v[0-9]+.[0-9]+.[0-9]+*)
    └── Job: Build & Publish
        ├── Resolve version + determine dist-tag (from tag or workflow_dispatch input)
        ├── Validate CalVer
        ├── npm ci + npm run build  (once)
        ├── Validate build artifacts
        ├── Build release tarball + checksums
        ├── Generate release notes from CHANGELOG
        ├── Create GitHub Release  (idempotent: gh release delete-then-create)
        ├── npm publish via OIDC
        ├── Update server.json version
        └── Publish to MCP Registry via mcp-publisher (OIDC)
```

A `workflow_dispatch` trigger is available as a break-glass option to retry a failed release without pushing a new tag. It accepts a `version` input; the tag must already exist on main.

### 8.4 npm Authentication (OIDC Trusted Publishing)

CLEO SHALL use npm OIDC Trusted Publishing for all npm publishes. This eliminates long-lived `NPM_TOKEN` secrets.

Requirements:
- GitHub Actions workflow permission: `id-token: write`
- Node.js 24+ (ships with npm >= 11.5.1 which supports OIDC)
- `registry-url: 'https://registry.npmjs.org'` in `actions/setup-node`
- Trusted Publisher configured on npmjs.com linking `@cleocode/cleo` to the repository and workflow filename

The `--provenance` flag is NOT required — provenance is automatically generated with trusted publishing.

Classic npm tokens and granular access tokens with write permissions are deprecated by npm (90-day max lifetime enforced since December 2025). OIDC trusted publishing is the only supported long-term authentication method.

### 8.5 npm Dist-Tag Mapping

| Tag suffix | GitHub Release | npm dist-tag |
|------------|---------------|-------------|
| *(none)* | release | `latest` |
| `-rc.N` | prerelease | `beta` |
| `-beta.N` | prerelease | `beta` |
| `-alpha.N` | prerelease | `dev` |
| `-dev.N` | prerelease | `dev` |

GitHub Releases are automatically marked as prerelease when the tag contains a hyphen.

### 8.6 CI Workflow Summary

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| `ci.yml` | Push to `main`/`develop`, PRs to both | Type check, test, build, verify |
| `release.yml` | Tag push `v*.*.*` or `workflow_dispatch` | GitHub Release + npm publish + MCP Registry (single consolidated job) |

### 8.7 Branch Strategy

CLEO follows a Git Flow branching model that maps branches to release channels:

| Branch | Channel | npm dist-tag | Tag pattern | PR target |
|--------|---------|-------------|-------------|-----------|
| `main` | stable | `@latest` | `vYYYY.M.PATCH` | `develop` → `main` (release PR) |
| `develop` | beta | `@beta` | `vYYYY.M.PATCH-beta.N` | feature/fix → `develop` |
| `feature/*`, `fix/*` | — | — | — | → `develop` |
| hotfix branches | stable | `@latest` | `vYYYY.M.PATCH` | → `main` directly |

#### Workflow

1. **Feature development**: Branch from `develop`, PR back to `develop`
2. **Beta releases**: Tag from `develop` with `-beta.N` suffix → publishes to npm `@beta`
3. **Stable releases**: PR `develop` → `main`, tag from `main` without suffix → publishes to npm `@latest`
4. **Hotfixes**: Branch from `main`, PR directly to `main`, tag stable release, then merge `main` back into `develop`

#### Branch Protection

- **`main`**: Required CI status checks (all matrix jobs), strict up-to-date requirement, 1 required approval, required commit signatures
- **`develop`**: Required CI status checks, non-strict (no up-to-date requirement), 0 required approvals (CI is the gate)

#### CalVer with Pre-release Tags

Pre-release tags have relaxed month enforcement — the tag month may be the current month or the next month. This allows end-of-month beta tagging for an upcoming release (e.g., `v2026.3.0-beta.1` tagged in late February). Stable tags require strict current-month matching.
