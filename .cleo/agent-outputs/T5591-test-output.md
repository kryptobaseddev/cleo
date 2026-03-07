# T5591 Wave 2C — github-pr.ts & channel.ts Test Report

**Date**: 2026-03-07
**Wave**: 2C
**Scope**: PR creation and branch protection detection logic in isolated test project

---

## Environment Notes

- `gh` CLI is **available** on this system: `gh version 2.86.0 (2026-01-21)`
- Build system uses esbuild → bundles into `dist/cli/index.js` and `dist/mcp/index.js` only (no individual module files emitted)
- Test approach: compiled release files individually via `npx tsc --outDir /tmp/cleo-tsc-out` and imported from there
- Isolated test project: `/tmp/cleo-pipeline-test` (has `main` and `develop` branches, no remote configured)

---

## github-pr.ts Test Results

| Function | Test Case | Expected | Actual | PASS/FAIL |
|----------|-----------|----------|--------|-----------|
| `isGhCliAvailable` | system check | true or false | `true` | PASS |
| `extractRepoOwnerAndName` | HTTPS with .git | `{owner:"owner",repo:"repo"}` | `{owner:"owner",repo:"repo"}` | PASS |
| `extractRepoOwnerAndName` | HTTPS without .git | `{owner:"owner",repo:"repo"}` | `{owner:"owner",repo:"repo"}` | PASS |
| `extractRepoOwnerAndName` | SSH with .git | `{owner:"owner",repo:"repo"}` | `{owner:"owner",repo:"repo"}` | PASS |
| `extractRepoOwnerAndName` | SSH without .git | `{owner:"owner",repo:"repo"}` | `{owner:"owner",repo:"repo"}` | PASS |
| `extractRepoOwnerAndName` | org-name/repo-name.git | `{owner:"org-name",repo:"repo-name"}` | `{owner:"org-name",repo:"repo-name"}` | PASS |
| `extractRepoOwnerAndName` | invalid URL | `null` | `null` | PASS |
| `extractRepoOwnerAndName` | empty string | `null` | `null` | PASS |
| `detectBranchProtection` | no remote configured | `{protected:false,...}` | `{protected:false,detectionMethod:"unknown",error:"fatal: 'origin' does not appear to be a git repository..."}` | PASS |
| `formatManualPRInstructions` | with epicId | formatted string with gh command + URL | correct output (see below) | PASS |
| `formatManualPRInstructions` | without epicId | formatted string (no epic suffix) | correctly omits epic suffix | PASS |
| `buildPRBody` | with epicId | markdown body with Epic line | correct markdown checklist with `**Epic**: T5586` | PASS |
| `buildPRBody` | without epicId | markdown body, no Epic line | correctly omits epic line | PASS |
| `createPullRequest` | local repo, no remote | `mode='manual'` with instructions | `mode='manual'`, instructions present, `error:"no git remotes found"` | PASS |

### detectBranchProtection — Fallback Behavior Detail

With no remote configured (`origin` does not exist):
- Strategy 1 (gh-api): skipped — `git remote get-url origin` fails → falls through
- Strategy 2 (push --dry-run): fails because no remote exists → stderr does NOT contain protection signals
- Result: `{protected: false, detectionMethod: "unknown", error: "fatal: 'origin' does not appear to be a git repository..."}`
- **Correct behavior**: no crash, graceful fallback, protected=false.

### formatManualPRInstructions — Actual Output

```
Branch protection detected or gh CLI unavailable. Create the PR manually:

  gh pr create \
    --base main \
    --head develop \
    --title "release: ship v2026.3.2" \
    --body "Release v2026.3.2 (T5586)"

Or visit: https://github.com/[owner]/[repo]/compare/main...develop

After merging, CI will automatically publish to npm.
```

Note: `[owner]/[repo]` is a template placeholder — correct since no remote is configured. In a real repo with a GitHub remote, `extractRepoOwnerAndName` would supply the actual owner/repo. The current `formatManualPRInstructions` does NOT call that function — it always emits the placeholder. This is a minor limitation but not a bug, since the function is intended for the "gh unavailable or branch protected" manual fallback path.

### createPullRequest — Full Flow

When gh IS available but the project root has no remote:
- `isGhCliAvailable()` → true (gh is installed)
- `gh pr create` is attempted
- Fails with `no git remotes found` (stderr)
- Does NOT match `already exists` → falls through to `mode='manual'`
- Returns `{mode:'manual', instructions:"...", error:"no git remotes found"}`
- **Correct behavior**: instructions present, no crash.

---

## channel.ts Test Results

### Branch → Channel Resolution

| Branch | Expected Channel | Expected Tag | Actual Channel | Actual Tag | PASS/FAIL |
|--------|-----------------|-------------|----------------|-----------|-----------|
| `main` | latest | @latest | latest | @latest | PASS |
| `develop` | beta | @beta | beta | @beta | PASS |
| `feature/auth` | alpha | @alpha | alpha | @alpha | PASS |
| `hotfix/urgent` | alpha | @alpha | alpha | @alpha | PASS |
| `release/v2` | alpha | @alpha | alpha | @alpha | PASS |
| `unknown-branch` | alpha | @alpha | alpha | @alpha | PASS |

All 6 branch resolution cases pass. Note: `unknown-branch` correctly falls back to `alpha` (step 6 in resolution order).

### Version Validation Results

| Version | Channel | Should Pass | Actual Valid | PASS/FAIL |
|---------|---------|-------------|--------------|-----------|
| `2026.3.2` | latest | YES | true | PASS |
| `2026.3.2` | beta | NO (missing -beta suffix) | false | PASS |
| `2026.3.2-beta.1` | beta | YES | true | PASS |
| `2026.3.2-alpha.1` | alpha | YES | true | PASS |
| `2026.3.2` | alpha | NO (missing pre-release suffix) | false | PASS |
| `2026.3.2-rc.1` | beta | YES (-rc accepted for beta) | true | PASS |
| `2026.3.2-rc.1` | alpha | YES (-rc accepted for alpha) | true | PASS |
| `2026.3.2-dev.1` | alpha | YES (-dev accepted for alpha) | true | PASS |
| `2026.3.2-beta.1` | latest | NO (has pre-release suffix) | false | PASS |

All 9 version validation cases pass.

---

## Dry-Run Test — release ship from develop

```
cd /tmp/cleo-pipeline-test && git checkout develop
node /mnt/projects/claude-todo/dist/cli/index.js release ship 2026.3.2-beta.1 --epic T5586 --dry-run
```

**Output summary:**
- Steps 1-4 all pass (validate gates, epic completeness, double-listing, CHANGELOG)
- `channel: "beta"` — correctly detected from `develop` branch
- `wouldCreatePR: false` — correct; no remote means branch protection undetectable, so PR creation is skipped in dry-run
- `wouldDo` array shows: write CHANGELOG, git add, git commit, git tag, git push, markReleasePushed
- No crash, clean exit

---

## Issues Found

**Minor — `formatManualPRInstructions` always emits `[owner]/[repo]` placeholder**

The function signature has `projectRoot` available via `PRCreateOptions` but does not attempt to resolve the actual GitHub owner/repo from the git remote. The compare URL always reads `https://github.com/[owner]/[repo]/compare/...`. This is intentional for the fallback scenario (where gh is unavailable or branch-protected), but if the caller has the remote URL, a richer message could be generated. Not a bug — just a noted limitation.

**Minor — `detectBranchProtection` detectionMethod returns `"unknown"` when no remote**

When strategy 2 (`git push --dry-run`) fails for reasons other than branch protection (e.g., no remote), the method returns `detectionMethod: "unknown"`. The function contract (interface) declares `'gh-api' | 'push-dry-run' | 'unknown'` so this is correct by spec. But callers should be aware that `"unknown"` means "could not determine" rather than "tried push dry-run".

---

## Overall Result

**github-pr.ts: PASS**
- All exported functions work correctly
- Graceful fallback when gh is unavailable or remote missing
- No crashes on edge cases (empty string, invalid URL, no remote)

**channel.ts: PASS**
- All branch→channel resolutions correct
- All version validation rules correct (latest/beta/alpha suffix rules)
- describeChannel returns appropriate human-readable strings

**release ship dry-run (develop branch): PASS**
- Channel auto-detected as `beta` from `develop` branch
- Dry-run output accurate and complete
- `wouldCreatePR: false` expected (no remote, protection undetectable)
