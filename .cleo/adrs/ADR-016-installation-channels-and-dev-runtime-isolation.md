# ADR-016: Installation Channels and Dev Runtime Isolation

**Date**: 2026-02-25
**Status**: accepted
**Accepted**: 2026-02-25
**Related Tasks**: T4881, T4882, T4883, T4884, T4885, T4886, T4887, T4888, T5063
**Related ADRs**: ADR-008, ADR-011, ADR-012, ADR-015
**Summary**: Defines three CLEO installation channels (npm global, npm local, dev symlink), establishes runtime isolation between dev and production instances, and specifies the CI/CD release pipeline with CalVer enforcement and OIDC trusted publishing.
**Keywords**: installation, channels, npm, global, local, dev, symlink, runtime-isolation, npm-link, calver, oidc, trusted-publishing, release, ci-cd
**Topics**: admin, tools, security, release

---

## 1. Context

CLEO currently has channel ambiguity between source code, globally installed npm package binaries, and provider MCP configurations. This ambiguity causes dogfooding failures where contributors edit source but execute an older global binary.

We need a canonical channel model that supports three modes without collisions:

1. Production stable installs for end users
2. Beta prerelease installs for early adopters
3. Contributor-local dev runtime in parallel with stable installs

Provider-specific MCP config management is delegated to CAAMP.

---

## 2. Decision

CLEO SHALL standardize on three runtime channels:

### 2.1 Stable Channel (`stable`)

- Package source: `@cleocode/cleo@latest`
- MCP runtime command: `npx -y @cleocode/cleo@latest mcp`
- Default MCP server name: `cleo`
- Optional global CLI install: `npm i -g @cleocode/cleo`
- Default data root: `~/.cleo`

### 2.2 Beta Channel (`beta`)

- Package source: `@cleocode/cleo@beta` (or exact `x.y.z-beta.n`)
- MCP runtime command: `npx -y @cleocode/cleo@beta mcp`
- Recommended MCP server name: `cleo-beta`
- Optional global CLI install: `npm i -g @cleocode/cleo@beta`
- Default data root: `~/.cleo` unless explicitly isolated

### 2.3 Contributor Dev Channel (`dev`)

- Runtime source: local repository build output
- CLI alias: `cleo-dev`
- MCP server name: `cleo-dev`
- Default dev data root: `~/.cleo-dev`
- Dev runtime MUST NOT overwrite stable global `cleo` unless explicitly requested
- Dev runtime MUST NOT create `ct` alias
- Dev runtime MUST NOT create `cleo` symlink by default

---

## 3. Channel Isolation Rules

1. Binary identity, MCP server name, and data root SHALL be treated as separate concerns.
2. `dev` runtime SHALL default to isolated data storage (`~/.cleo-dev`).
3. `dev` runtime SHALL expose only `cleo-dev` command surface; legacy `ct` alias is excluded.
4. Installer link creation SHALL be centralized in `installer/lib/link.sh` with channel-aware mapping.
5. Duplicate ad-hoc symlink logic in other installer entry points SHOULD be removed.
6. Provider MCP profiles SHALL be installed and managed by CAAMP (not by ad-hoc manual snippets in CLEO docs).
7. CLEO docs SHALL publish channel contract semantics, while CAAMP docs/commands SHALL publish provider-specific configuration details.
8. Archived/dev-only scripts MUST NOT be referenced by production install paths.

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

## 7. Installer Policy

### 7.1 Mode-aware command/link mapping

- `stable`: `cleo`, `ct` (compat), server `cleo` — MCP via `cleo mcp`
- `beta`: `cleo-beta`, optional `ct-beta`, server `cleo-beta` — MCP via `cleo-beta mcp`
- `dev`: `cleo-dev`, server `cleo-dev`, no `ct` — MCP via `cleo-dev mcp`

> **Note**: As of v2026.2.9, standalone `cleo-mcp` binaries are removed. MCP servers are launched via the `cleo mcp` pseudo-subcommand (see commit `6c955628`).

### 7.2 Production-path script policy

- Production installer MUST NOT reference scripts under `/dev` or `/dev/archived`.
- Existing `setup-claude-aliases` behavior is removed from CLEO installer flow and delegated to CAAMP as optional utility tooling.

### 7.3 npm bin caveat

`package.json` may expose compatibility bins (`ct`) for package installs. Channel-aware installer behavior still defines which links are created per mode, and `dev` mode excludes `ct`.

### 7.4 Contributor `npm link` caveat

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

The release pipeline uses a single-workflow design in `.github/workflows/release.yml` with three sequential jobs:

```
git tag vYYYY.M.PATCH → git push origin vYYYY.M.PATCH
    ↓
release.yml (triggered by tag push matching v[0-9]+.[0-9]+.[0-9]+*)
    ├── Job 1: release         — Build, validate, create GitHub Release
    ├── Job 2: publish-npm     — npm publish via OIDC (needs: release)
    └── Job 3: publish-mcp    — MCP Registry publish (needs: publish-npm)
```

A manual fallback workflow exists at `.github/workflows/npm-publish.yml` for re-publishing without creating a new release. It requires explicit dist-tag selection (dev/beta/latest).

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
| `release.yml` | Tag push `v*.*.*` | GitHub Release + npm + MCP Registry |
| `npm-publish.yml` | Manual dispatch only | Backup re-publish with explicit dist-tag |

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
