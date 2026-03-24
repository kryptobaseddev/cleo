# CAAMP Code Quality & Gap Audit

**Date**: 2026-02-11
**Version Audited**: 0.3.0 (in progress)
**Auditor**: code-auditor agent

---

## Summary

| Severity | Count |
|----------|-------|
| Critical | 2 |
| High | 7 |
| Medium | 10 |
| Low | 8 |
| **Total** | **27** |

**Overall Assessment**: The codebase is **not production-ready** for a v1.0.0 release. The core architecture is sound and well-structured, but significant gaps remain in error handling, test coverage, and operational safety. The code is appropriate for a v0.3.0 pre-release. The two critical issues (no global error handler and silent network failure swallowing) should be fixed before any public beta.

---

## 1. GAP-ANALYSIS.md Remaining Items

### 1.1 Deferred to Future Versions

| Item | Section | Notes |
|------|---------|-------|
| Integration test suites | 2.2, 5.3 | Deferred from v0.2.0 to v0.3.0, still not done |
| `caamp migrate` command | 4.4 | Migrate MCP configs between providers |
| `caamp sync` command | 4.4 | Sync MCP servers across providers |
| `caamp export/import` commands | 4.4 | Config sharing for teams |
| CI/CD integration (GitHub Actions) | 4.4, 6.2 | Automated skill auditing |
| Team config sharing (`.caamprc.json`) | 4.4, 6.3 | Project-level team config |
| Config templates | 6.4 | `caamp init --template web-dev` |
| Plugin system | 6.1 | Community-contributed providers |
| Interactive prompts | 4.4 | @clack/prompts declared but unused |
| Config backup before destructive writes | 4.4 | No safety net for config writes |
| Rollback mechanism | 4.4 | No undo for failed installs |
| Telemetry opt-in | 4.4 | No usage analytics |
| Well-known discovery CLI command | 4.4 | `wellknown.ts` exists but unexposed |
| Help text with examples | 4.4 | Commands have descriptions only |

### 1.2 Items Marked In-Progress

| Item | Section | Status |
|------|---------|--------|
| TSDoc annotations (T031) | 5.7 | In progress |
| TypeDoc generation (T032) | 5.7 | In progress |

### 1.3 Open Error Handling Items (from Section 4.2)

| Location | Issue |
|----------|-------|
| `src/core/lock-utils.ts:25` | Silent catch on corrupted lock file |
| `src/core/formats/json.ts:24-26` | Fallback JSON.parse may throw unhandled |
| `src/core/sources/github.ts:35` | git clone failure gives no user-friendly error |
| `src/core/marketplace/client.ts:70` | Network errors silently swallowed |
| All CLI commands | No global error handler |

### 1.4 Open Command Gaps (from Section 2.5)

| Command | Gap |
|---------|-----|
| `skills install` | No `--force` flag; no version pinning for marketplace installs |
| `skills find` | No pagination or category/author filtering in CLI |
| `mcp install` | No interactive agent selection |
| `mcp list` | No `--all` flag for combined global+project listing |
| `config show` | Does not resolve `$HOME`/`$CONFIG` in paths |

### 1.5 v1.0.0 Stability Criteria NOT Met

| Criterion | Section | Status |
|-----------|---------|--------|
| 80% line coverage across all core modules | 7.2 | Far below -- many modules at 0% |
| 100% of public API functions have unit tests | 7.2 | ~60% covered |
| Integration test suite for all CLI commands | 7.2 | 0 integration tests |
| Cross-platform CI (Linux, macOS, Windows) | 7.2 | No CI at all |
| Performance benchmarks | 7.2 | None |
| API reference from TSDoc | 7.3 | In progress |
| Per-provider configuration guide | 7.3 | Missing |
| Migration guide | 7.3 | Missing |
| Contributing guidelines | 7.3 | Missing |
| Architecture decision records | 7.3 | Missing |
| Issue templates | 7.4 | Missing |
| PR review process | 7.4 | Missing |
| Release cadence | 7.4 | Not defined |
| Security disclosure policy | 7.4 | Missing |

### 1.6 Risk Register Items Needing Attention

| Risk | Status |
|------|--------|
| Lock file corruption from concurrent writes | Open -- no file locking implemented |
| Marketplace API changes | Open -- no response schema validation |
| Provider config format changes | Open -- no automated format tests |
| Provider proliferation (46 entries) | Open -- no community contribution process |

---

## 2. TODO/FIXME/HACK Comments in Source

**Result: ZERO** instances found.

Searched `src/` for `TODO`, `FIXME`, `HACK`, `TEMPORARY`, `WORKAROUND` (case-insensitive). No matches. The codebase is clean of inline debt markers. This is good hygiene, though it also means known issues are tracked externally (in GAP-ANALYSIS.md) rather than inline.

---

## 3. Error Handling Analysis

### 3.1 `src/core/marketplace/client.ts` -- Network Errors Silently Swallowed

**Severity: Critical**

**Location**: `client.ts:70`
```typescript
adapter.search(query, limit).catch(() => [] as MarketplaceResult[])
```

Both adapters (`skillsmp.ts:64`, `skillssh.ts:55`) also silently return `[]` on any error. The user gets an empty result set with no indication that:
- The network is down
- The API returned 500
- DNS resolution failed
- The API changed its response format

**Same pattern in `getSkill`** at `client.ts:107`: `.catch(() => null)`.

**Impact**: User runs `caamp skills find "filesystem"` and sees "No results" when the actual problem is no internet. This is a poor user experience and hard to debug.

**Recommendation**: Log warnings (using the existing `warn()` logger) when network calls fail. Return results with a metadata flag indicating partial/failed backends.

### 3.2 `src/core/sources/github.ts` -- Clone Failure Messages

**Severity: High**

**Location**: `github.ts:35`
```typescript
await git.clone(repoUrl, tmpDir, cloneOptions);
```

No try/catch around the clone. If the clone fails (wrong URL, no auth, network down, invalid ref), the raw `simple-git` error propagates up with a message like `fatal: repository 'https://github.com/...' not found`. The user gets a stack trace instead of actionable guidance.

**Also applies to**: `gitlab.ts:28` -- identical pattern.

**Recommendation**: Wrap in try/catch with user-friendly messages for common failures (404 = repo not found, auth failures, network errors).

### 3.3 `src/core/formats/json.ts` -- JSONC Fallback Exception

**Severity: Medium**

**Location**: `json.ts:23-25`
```typescript
if (errors.length > 0) {
  return JSON.parse(content) as Record<string, unknown>;
}
```

When `jsonc.parse` reports errors, the code falls back to `JSON.parse`. If the file contains actual JSONC (comments, trailing commas), `JSON.parse` will also throw. This exception is unhandled and will bubble up as a raw `SyntaxError`.

**Recommendation**: Wrap the fallback in try/catch and provide a clear error message like "Config file at <path> contains invalid JSON/JSONC".

### 3.4 `src/core/lock-utils.ts` -- Corrupted Lock File Handling

**Severity: Medium**

**Location**: `lock-utils.ts:25`
```typescript
} catch {
  return { version: 1, skills: {}, mcpServers: {} };
}
```

If the lock file exists but contains corrupted JSON, it silently returns an empty default. This means:
- All tracked installations disappear from the user's perspective
- The next write overwrites the corrupted file with a fresh one
- No indication to the user that their lock data was lost

**Recommendation**: Log a warning that the lock file was corrupted and is being reset. Consider backing up the corrupted file before overwriting.

### 3.5 No Global Error Handler in CLI

**Severity: Critical**

**Location**: `cli.ts` (entire file)

The CLI entry point has no `process.on("uncaughtException")` or `process.on("unhandledRejection")` handlers. Unhandled promise rejections or thrown errors will produce raw stack traces to the user.

For example, if `JSON.parse` throws in the JSONC fallback path (3.3 above), the user sees:
```
SyntaxError: Unexpected token / in JSON at position 0
    at JSON.parse (<anonymous>)
    at readJsonConfig (file:///...)
```

**Recommendation**: Add a global error handler that catches unhandled exceptions, prints a user-friendly message, and suggests `--verbose` for the full stack trace.

### 3.6 No Fetch Timeouts

**Severity: High**

**Locations**: All `fetch()` calls across the codebase have no timeout:
- `src/core/marketplace/skillsmp.ts:59` -- agentskills.in API
- `src/core/marketplace/skillssh.ts:50` -- skills.sh API
- `src/core/sources/github.ts:61` -- GitHub raw file fetch
- `src/core/sources/github.ts:72` -- GitHub API repo check
- `src/core/sources/gitlab.ts:55` -- GitLab raw file fetch
- `src/core/sources/wellknown.ts:18` -- Well-known URL fetch

If any of these endpoints hang (e.g., firewall black-holing traffic), the CLI will hang indefinitely with no output.

**Recommendation**: Use `AbortSignal.timeout(10000)` (Node 18+) on all fetch calls. Example: `fetch(url, { signal: AbortSignal.timeout(10_000) })`.

---

## 4. Missing Test Coverage

### 4.1 Core Modules with ZERO Tests

| Source File | Lines | Test File | Status |
|-------------|-------|-----------|--------|
| `src/core/mcp/installer.ts` | 206 | None | **No tests** |
| `src/core/mcp/transforms.ts` | 142 | None | **No tests** |
| `src/core/sources/github.ts` | 80 | None | **No tests** |
| `src/core/sources/gitlab.ts` | 62 | None | **No tests** |
| `src/core/sources/wellknown.ts` | 27 | None | **No tests** |
| `src/core/skills/discovery.ts` | ~100 | None | **No tests** |
| `src/core/skills/lock.ts` | 199 | `lock.test.ts` (3) | **Only data structure tests, no I/O** |
| `src/core/lock-utils.ts` | 35 | None | **No tests** |
| `src/core/logger.ts` | 90 | None | **No tests** |
| `src/core/registry/detection.ts` | 200 | None | **No tests** |

### 4.2 Test Coverage Map

| Module | Source Files | Total Lines | Test Count | Estimated Coverage |
|--------|-------------|-------------|------------|-------------------|
| registry/ | 3 | 379 | 14 | ~40% (providers tested, detection untested) |
| formats/ | 5 | 443 | 18 | ~60% (JSON/YAML tested, TOML untested) |
| mcp/ | 4 | 415 | 18 | ~30% (reader tested, installer+transforms untested) |
| skills/ | 6 | 851 | 8+3 | ~15% (validator tested, installer/discovery/lock barely tested) |
| marketplace/ | 4 | 238 | 21 | ~80% (client, adapters well tested) |
| sources/ | 4 | 320 | 13 | ~30% (parser tested, fetchers untested) |
| instructions/ | 2 | 232 | 25 | ~90% (well tested) |
| logger.ts | 1 | 90 | 0 | 0% |
| lock-utils.ts | 1 | 35 | 0 | 0% |
| **Overall** | **30** | **2,953** | **120** | **~35%** |

### 4.3 Specific Untested Functionality

- **MCP transforms**: 5 transforms (Goose, Zed, OpenCode, Codex, Cursor) with zero tests. These handle critical config format differences.
- **MCP installer**: `installMcpServer` and `installMcpServerToAll` -- core write path untested.
- **GitHub/GitLab cloning**: The entire remote fetch pipeline has no tests.
- **Detection engine**: `checkBinary`, `checkDirectory`, `checkAppBundle`, `checkFlatpak` -- all untested.
- **TOML format**: `writeTomlConfig` and `removeTomlConfig` exist but have zero tests. Codex uses TOML.
- **Skills lock `checkSkillUpdate`**: The version comparison logic (`!latestSha.startsWith(currentVersion.slice(0, 7))`) is untested and may have edge cases.

---

## 5. Hardcoded Values

### 5.1 Hardcoded URLs

| File | Line | Value | Concern |
|------|------|-------|---------|
| `marketplace/skillsmp.ts:10` | `API_BASE` | `https://www.agentskills.in/api/skills` | Not configurable; breaks if API moves |
| `marketplace/skillssh.ts:10` | `API_BASE` | `https://skills.sh/api` | Not configurable; breaks if API moves |
| `sources/github.ts:26` | `repoUrl` | `https://github.com/` | Only public GitHub; no GitHub Enterprise |
| `sources/github.ts:58` | `url` | `https://raw.githubusercontent.com/` | Same -- no GHE support |
| `sources/github.ts:72` | `url` | `https://api.github.com/` | Same -- no GHE support |
| `sources/gitlab.ts:19` | `repoUrl` | `https://gitlab.com/` | Only public GitLab; no self-hosted |
| `sources/gitlab.ts:52` | `url` | `https://gitlab.com/` | Same |
| `sources/wellknown.ts:15` | `url` | `https://${domain}/.well-known/...` | Forces HTTPS (acceptable) |
| `instructions/templates.ts:33` | | `https://github.com/caamp/caamp` | Hardcoded repo URL in injected content |

**Severity**: Medium for marketplace URLs (should be configurable). Low for GitHub/GitLab (GHE/self-hosted is a future feature).

### 5.2 Hardcoded Paths

| File | Line | Value | Concern |
|------|------|-------|---------|
| `lock-utils.ts:14` | `LOCK_DIR` | `join(homedir(), ".agents")` | Not configurable via env var |
| `lock-utils.ts:15` | `LOCK_FILE` | `join(LOCK_DIR, ".caamp-lock.json")` | Same |
| `skills/installer.ts:15` | `CANONICAL_DIR` | `join(homedir(), ".agents", "skills")` | Same |
| `commands/doctor.ts:122` | | `join(homedir(), ".agents", "skills")` | Duplicated from installer.ts |

**Severity**: Medium. The `.agents` directory path is used in 4+ places and should be a single constant or configurable via `CAAMP_HOME` or similar env var.

### 5.3 Hardcoded Timeouts

| File | Line | Value | Concern |
|------|------|-------|---------|
| `mcp/transforms.ts:21` | `timeout: 300` | Goose remote config | Not user-configurable |
| `mcp/transforms.ts:33` | `timeout: 300` | Goose stdio config | Same |

**Severity**: Low. These are Goose-specific defaults and 300 seconds is reasonable.

### 5.4 Missing Fetch Timeouts

All `fetch()` calls (6 locations listed in 3.6) have no timeout at all. This is a significant operational risk.

**Severity**: High.

---

## 6. Planned Status Providers

7 providers in `registry.json` have `"status": "planned"`:

| Provider | ID | Vendor | Assessment |
|----------|-----|--------|-----------|
| **Mentat** | `mentat` | AbanteAI | **Remove or keep planned**. Low adoption, no confirmed MCP support. AbanteAI may be inactive. |
| **Blackbox AI** | `blackbox-ai` | Blackbox | **Keep planned**. MCP support unconfirmed. Config paths are speculative. |
| **Sourcery** | `sourcery` | Sourcery | **Keep planned**. Python-focused code review tool. MCP support unconfirmed. |
| **Sweep** | `sweep` | Sweep AI | **Remove**. Sweep AI appears to be discontinued/pivoted. Empty config paths (`""`) suggest no real data. No detection methods configured. |
| **Codegen** | `codegen` | Codegen | **Keep planned**. Config paths are speculative but reasonable. |
| **Double** | `double` | Double | **Keep planned**. Config paths are speculative. |
| **Supermaven** | `supermaven` | Supermaven | **Remove**. Supermaven merged into Cursor in November 2024 (noted in GAP-ANALYSIS.md Section 3.7). Should not exist as a separate provider. |

**Recommendations**:
- **Remove**: `sweep` (discontinued, empty config) and `supermaven` (merged into Cursor -- the gap analysis itself says "Do not add as a provider" but it was added anyway)
- **Keep**: `mentat`, `blackbox-ai`, `sourcery`, `codegen`, `double` -- low-risk placeholders
- **Note**: All 7 planned providers have `"agentSkillsCompatible": false` which is correct for unverified entries

---

## 7. Additional Findings

### 7.1 Logger Module State Problem

**Severity**: Low
**Location**: `src/core/logger.ts:8-9`

The logger uses module-level mutable state (`verboseMode`, `quietMode`). This is fine for CLI use but creates issues for library consumers who may want isolated logger instances. Since CAAMP exports the logger functions as library API, concurrent or embedded usage could have unexpected behavior.

### 7.2 Lock File Race Condition

**Severity**: High
**Location**: `src/core/lock-utils.ts`

The read-modify-write pattern in `readLockFile()` -> modify -> `writeLockFile()` is not atomic. If two `caamp` processes run simultaneously (e.g., parallel MCP installs), the second write will overwrite the first's changes. This is documented in the risk register (GAP-ANALYSIS Section 8) but has no mitigation implemented.

### 7.3 Detection Engine Runs All Providers

**Severity**: Medium
**Location**: `src/core/registry/detection.ts:149-152`

`detectAllProviders()` iterates all 46 providers and runs `execFileSync("which"/"where")` for each binary check. This is synchronous and blocks the event loop. With 46 providers, this means up to 46 synchronous child process spawns.

### 7.4 Symlink Fallback Has No User Notification

**Severity**: Medium
**Location**: `src/core/skills/installer.ts:101-103`

```typescript
} catch {
  // Fallback to copy if symlinks not supported
  await cp(canonicalPath, linkPath, { recursive: true });
}
```

When symlinks fail (e.g., Windows without developer mode), the code silently falls back to a full copy. The user is not informed that their skill installation is a copy rather than a symlink, which means future `skills update` won't propagate to copies.

### 7.5 Version String Hardcoded in CLI

**Severity**: Low
**Location**: `src/cli.ts:21`

```typescript
.version("0.3.0")
```

The version is hardcoded rather than read from `package.json`. This creates a maintenance burden where version bumps must update two files.

### 7.6 Duplicate Canonical Path Constant

**Severity**: Low
**Location**: `src/core/skills/installer.ts:15` and `src/commands/doctor.ts:122`

The canonical skills directory `join(homedir(), ".agents", "skills")` is computed in two places. If one changes, the other becomes inconsistent.

### 7.7 `@clack/prompts` Unused Dependency

**Severity**: Low
**Location**: `package.json`

The `@clack/prompts` dependency is declared but used nowhere in the codebase for its intended purpose (interactive prompts for MCP agent selection, skill install confirmation, etc.). This is dead weight.

---

## 8. Findings by Severity

### Critical (2)

| # | Finding | Location | Action |
|---|---------|----------|--------|
| C1 | No global error handler -- unhandled rejections show raw stack traces | `src/cli.ts` | Add `process.on("uncaughtException")` and `process.on("unhandledRejection")` |
| C2 | Network errors silently swallowed across all marketplace and fetch operations | `marketplace/client.ts`, `skillsmp.ts`, `skillssh.ts` | Log warnings, surface failure reason to user |

### High (7)

| # | Finding | Location | Action |
|---|---------|----------|--------|
| H1 | git clone failures produce raw error messages | `sources/github.ts:35`, `sources/gitlab.ts:28` | Wrap in try/catch with user-friendly messages |
| H2 | No fetch timeouts -- CLI can hang indefinitely | 6 `fetch()` call sites | Add `AbortSignal.timeout(10_000)` |
| H3 | Lock file race condition -- concurrent writes lose data | `lock-utils.ts` | Implement file locking or atomic writes |
| H4 | MCP installer has zero tests | `mcp/installer.ts` | Add unit tests for core write path |
| H5 | MCP transforms have zero tests | `mcp/transforms.ts` | Add unit tests for all 5 transforms |
| H6 | GitHub/GitLab fetchers have zero tests | `sources/github.ts`, `sources/gitlab.ts` | Add unit tests with mocked git/fetch |
| H7 | Detection engine has zero tests | `registry/detection.ts` | Add unit tests with mocked exec calls |

### Medium (10)

| # | Finding | Location | Action |
|---|---------|----------|--------|
| M1 | JSONC fallback to JSON.parse may throw unhandled | `formats/json.ts:24-26` | Wrap in try/catch |
| M2 | Corrupted lock file silently discarded | `lock-utils.ts:25` | Log warning, backup corrupted file |
| M3 | Symlink fallback to copy has no user notification | `skills/installer.ts:101-103` | Log warning about copy vs symlink |
| M4 | Detection runs 46 sync child processes | `registry/detection.ts` | Consider async or caching |
| M5 | `.agents` path hardcoded in 4+ places | Multiple | Extract to shared constant |
| M6 | Marketplace API URLs not configurable | `skillsmp.ts:10`, `skillssh.ts:10` | Allow env var override |
| M7 | Supermaven provider should be removed (merged into Cursor) | `registry.json` | Remove entry |
| M8 | Sweep provider should be removed (discontinued) | `registry.json` | Remove entry |
| M9 | ~35% estimated test coverage vs 80% v1.0 target | All of `src/core/` | Significant test writing needed |
| M10 | No integration or e2e tests | `tests/` | Entire test tier missing |

### Low (8)

| # | Finding | Location | Action |
|---|---------|----------|--------|
| L1 | Version hardcoded in cli.ts | `cli.ts:21` | Read from package.json |
| L2 | Duplicate canonical path constant | `installer.ts:15`, `doctor.ts:122` | Share constant |
| L3 | @clack/prompts unused dependency | `package.json` | Remove or implement interactive prompts |
| L4 | Logger uses module-level mutable state | `logger.ts:8-9` | Document limitation for library consumers |
| L5 | Goose timeout hardcoded to 300 | `transforms.ts:21,33` | Low priority -- reasonable default |
| L6 | No GHE/self-hosted GitLab support | `sources/github.ts`, `sources/gitlab.ts` | Future feature |
| L7 | GitLab nested groups not supported | `sources/parser.ts` | Edge case |
| L8 | Large SKILL.md files (>1MB) read entirely into memory | `skills/validator.ts` | Add size guard |

---

## 9. Production Readiness Assessment

**Verdict: NOT production-ready for v1.0.0.**

The codebase has a solid foundation:
- Clean architecture with good separation of concerns
- Zero TODO/FIXME/HACK markers
- Well-structured TypeScript with strict mode
- Adapter pattern for marketplaces provides good extensibility
- Good TSDoc coverage on public APIs

However, the following blocks a v1.0.0 release:
1. **Error handling**: Critical gaps where the CLI silently fails or shows stack traces
2. **Test coverage**: ~35% estimated vs 80% target. Core write paths (MCP installer, transforms) are untested.
3. **Operational safety**: No fetch timeouts, no lock file safety, no config backups
4. **No CI/CD pipeline**: No automated testing on any platform
5. **Community process**: No contribution guidelines, issue templates, or security policy

For the current v0.3.0 milestone, the codebase is in reasonable shape if the two critical issues (C1, C2) are addressed.
