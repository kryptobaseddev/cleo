# Release Process

This document describes the canonical release process for `@cleocode/monorepo` and all packages.

## TL;DR: The Canonical Path (v2026.5.43+)

**All releases MUST go through the PR-gated pipeline (ADR-065). Direct pushes to `main` are prohibited.**

```bash
# 1. Prepare release handle
cleo release start vYYYY.MM.N

# 2. Ship — auto-cuts release/vX.Y.Z branch, opens PR, waits for CI green, merges + tags
cleo release ship YYYY.MM.N --epic TXXXX

# 3. Poll CI status while waiting
cleo release pr-status YYYY.MM.N
```

`cleo release ship` handles version bumps, lockfile updates, CHANGELOG generation,
branch creation, PR opening, CI wait, merge, and tag automatically.

### Legacy Manual Steps (pre-v2026.5.43 — do not use)

The steps below are preserved for historical reference only. They are **superseded** by
`cleo release ship` as of ADR-065. Do not follow them for new releases.

<details>
<summary>Pre-ADR-065 manual process (archived)</summary>

1. **Bump versions** in all `package.json` files using `pnpm version:bump`
2. **Install dependencies** to regenerate `pnpm-lock.yaml`
   ```bash
   pnpm install
   ```
3. **Commit both files together**
   ```bash
   git add package.json pnpm-lock.yaml
   git commit -m "chore(release): vXXXX.X.XX"
   ```
4. **Push the tag** to GitHub
   ```bash
   git tag vXXXX.X.XX
   git push origin vXXXX.X.XX
   ```
5. **GitHub Actions publishes automatically**
   - The Release workflow (`.github/workflows/release.yml`) detects the new tag
   - It runs all tests and builds automatically
   - On success, it publishes to npm

</details>

---

## Why You Should Never `npm publish` Locally (ORC-011)

On 2026-04-15, worker T665 bypassed the canonical release process and published v2026.4.59 to npm **after** GitHub CI had already failed due to `pnpm-lock.yaml` drift. This violated the **Orchestration Rule ORC-011**: *"Never bypass CI gates to publish."*

### What Went Wrong

1. Local `package.json` was updated without regenerating `pnpm-lock.yaml`
2. GitHub CI detected the drift and **RED-LIGHTED** before running expensive jobs
3. The worker ignored the red CI and ran `npm publish` locally anyway
4. The npm package was published with an inconsistent lockfile state
5. Downstream users who installed from npm got a potentially unstable version

### Safeguards Now in Place

**Pre-commit hook** (`.git/hooks/pre-commit`):
- Blocks any commit where `package.json` changes without a corresponding `pnpm-lock.yaml` change
- Verifies the lockfile passes `--frozen-lockfile` check
- Gives clear instructions to run `pnpm install` before retrying

**GitHub Actions workflow** (`.github/workflows/lockfile-check.yml`):
- Runs as a dedicated, fast gate on all PRs and pushes to `main`
- Executes before the heavy CI matrix (tests, build, etc.)
- Red-lights immediately if `pnpm install --frozen-lockfile` fails
- Prevents any downstream CI job from running while lockfile is inconsistent

**Release workflow best practices**:
- Always bump versions, run `pnpm install`, and commit both files before pushing the tag
- Let GitHub Actions Release workflow handle publishing—never do `npm publish` locally
- If CI is red, **never push a tag**—investigate and fix the CI issues first

---

## Step-by-Step Release Checklist (ADR-065 · v2026.5.43+)

### 1. Preparation

```bash
# Ensure you're on main and up-to-date
git pull origin main

# Verify no uncommitted changes
git status

# Check gh CLI auth
gh auth status
```

### 2. Start the Release Handle

```bash
cleo release start v2026.MM.N
```

This validates the version scheme (CalVer), captures the current branch, and persists
`.cleo/release/handle.json` for subsequent steps.

### 3. Ship Through the Pipeline

```bash
cleo release ship 2026.MM.N --epic T####
```

This single command executes all 12 pipeline steps:
1. Validate release gates (quality gates pass)
2. Run IVTR loop check
3. Verify epic completeness
4. Double-listing guard
5. Generate CHANGELOG (only tasks completed after previous version)
6. Run biome lint
7. Cut `release/v2026.MM.N` branch
8. Commit CHANGELOG + version bump
9. Push branch
10. Open PR via `gh pr create`
11. Wait for CI green (15-minute timeout)
12. Merge with `--merge`, tag from main, cleanup branch

### 4. Monitor PR / CI

```bash
# Poll CI check status
cleo release pr-status 2026.MM.N

# Or watch GitHub Actions directly
gh run list --branch release/v2026.MM.N
```

### 5. After Merge

GitHub Actions Release workflow triggers automatically from the tag. On success, npm
package is published automatically. Do NOT run `npm publish` locally.

```bash
# Verify tag landed
git fetch --tags && git tag | grep v2026.MM.N
```

---

## What to Do If CI Is Red

With the ADR-065 PR-gated pipeline, `cleo release ship` will not merge or tag if CI is red.
The pipeline exits with an error and leaves the release PR open. Do not force-merge.

### During a `cleo release ship` run

1. Check PR CI status: `cleo release pr-status <version>` or `gh pr checks <pr-number>`
2. If a check is failing, fix the issue on the release branch:
   ```bash
   git checkout release/v<version>
   # fix the issue
   git commit -m "fix: <description>"
   git push origin release/v<version>
   ```
3. CI will re-run. Once green, re-run `cleo release ship` (it resumes from the open PR).

### If the 15-minute CI timeout expires

The PR is left open. You can resume manually:

```bash
# Wait for CI then merge
gh pr merge release/v<version> --merge

# Tag from main after merge
git fetch --tags
git tag v<version> main
git push origin v<version>
```

### Pre-ADR-065: If a red tag was accidentally pushed (historical)

1. **Delete the tag from GitHub**
   ```bash
   git push origin --delete vXXXX.X.XX
   ```

2. **Revert the version commit**
   ```bash
   git revert <commit-hash>
   git push origin main
   ```

3. Fix the underlying issue and create a new release with the next version number

---

## CalVer Version Scheme

This project uses **CalVer** (Calendar Versioning) with the format `YYYY.MM.patch`:

- **YYYY**: Current year (e.g., `2026`)
- **MM**: Current month (e.g., `04`)
- **patch**: Sequential patch number for the month (e.g., `59`)

Example: `v2026.4.59` = April 2026, patch 59

Never use SemVer (e.g., `v1.2.3`) for this project.

---

## References

- **ADR-065**: PR-Required Release Flow (this change)
- **ADR-063**: Canonical Release Pipeline
- **ADR-051**: Evidence-based gate ritual
- **ORC-011**: Orchestration rule prohibiting CI bypass
- **ADR-039**: LAFS envelope format for all CLI output
- **Lockfile Guard Implementation**: T716
- **Previous Incident**: T665 (local publish violation)
- **Branch Protection Setup**: `docs/release/branch-protection-setup.md`

---

## Questions?

Refer to `AGENTS.md` section "Release & Branching" for branch conventions, or run
`cleo memory find "release"` for recent decisions.
