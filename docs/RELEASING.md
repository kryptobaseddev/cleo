# Release Process

This document describes the canonical release process for `@cleocode/monorepo` and all packages.

## TL;DR: The Canonical Path

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

## Step-by-Step Release Checklist

### 1. Preparation

```bash
# Ensure you're on main and up-to-date
git checkout main
git pull origin main

# Verify no uncommitted changes
git status
```

### 2. Version Bump

```bash
# Update all package.json versions using the project's version script
pnpm version:bump

# Verify the versions look correct
git diff package.json
```

### 3. Lock Consistency

```bash
# Regenerate lockfile to match new package.json
pnpm install

# Verify lockfile changes are reasonable
git diff pnpm-lock.yaml | head -50
```

### 4. Commit Both Files

```bash
# Stage both updated files
git add package.json pnpm-lock.yaml

# Commit with standard release message
git commit -m "chore(release): vXXXX.X.XX"

# Verify the commit
git show --stat
```

### 5. Push the Tag

```bash
# Create annotated tag
git tag -a vXXXX.X.XX -m "Release vXXXX.X.XX"

# Push to GitHub (both tag and main branch)
git push origin main
git push origin vXXXX.X.XX
```

### 6. Monitor GitHub Actions

- GitHub Actions Release workflow (`.github/workflows/release.yml`) automatically triggers
- Monitor the workflow run at: `https://github.com/cleocode/cleo/actions`
- On success, npm package is automatically published
- On failure, **DO NOT** republish locally—investigate the failure and fix on a new version

---

## What to Do If CI Is Red

### Before Pushing a Tag

1. Check `.github/workflows/lockfile-check.yml` results first
   - If lockfile check failed, **stop**—do not push the tag
   - Fix the inconsistency locally: `pnpm install && git add pnpm-lock.yaml`

2. Wait for full CI to pass (tests, build, lint)
   - If any job fails, **stop**—do not push the tag
   - Create a fix branch, commit, and open a PR

3. Only push the tag after **all** CI jobs pass

### If You Accidentally Pushed a Red Tag

1. **Delete the tag from GitHub** (ask maintainers for access)
   ```bash
   git push origin --delete vXXXX.X.XX
   ```

2. **Revert the version commit** (create a new commit that undoes it)
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

- **ORC-011**: Orchestration rule prohibiting CI bypass
- **ADR-039**: LAFS envelope format for all CLI output
- **Lockfile Guard Implementation**: T716
- **Previous Incident**: T665 (local publish violation)

---

## Questions?

Refer to the memory context at `.cleo/memory-bridge.md` for recent decisions and patterns.
