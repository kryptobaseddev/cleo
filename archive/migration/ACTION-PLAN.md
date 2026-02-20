# CLEO Bash to TypeScript Migration Action Plan

**Version:** 1.0  
**Date:** 2026-02-19  
**Status:** Ready for Execution

## Overview

This document provides the step-by-step action plan for cleanly separating the deprecated Bash system from the active TypeScript system while maintaining the Bash code for comparison purposes.

## Phase 1: Archive Bash Code

### Step 1: Create Archive Branch
```bash
git checkout -b migration/bash-to-ts-separation
```

### Step 2: Copy Bash Code to Archive
```bash
# Create archive structure
mkdir -p archive/bash-legacy/{scripts,lib,tests,docs}

# Copy all Bash code
cp -r scripts/* archive/bash-legacy/scripts/
cp -r lib/* archive/bash-legacy/lib/
cp -r tests/* archive/bash-legacy/tests/

# Create README
cat > archive/bash-legacy/README.md << 'EOF'
# CLEO Bash Legacy Code (DEPRECATED)

This directory contains the deprecated Bash-based implementation preserved for reference.

## Contents
- scripts/ - 86 Bash CLI scripts
- lib/ - 119 Bash library files  
- tests/ - BATS test suite

## Status
⚠️ DEPRECATED: No longer maintained. Use TypeScript implementation in src/.

## Usage
Do not use these scripts. Use the TypeScript CLI:
- cleo add "Task" (not ./scripts/add.sh)
- cleo list (not ./scripts/list.sh)
EOF
```

### Step 3: Commit Archive
```bash
git add archive/
git commit -m "archive: preserve Bash legacy code (T####)"
```

## Phase 2: Remove from Git Tree

### Step 4: Remove Bash Directories
```bash
# Remove from git tracking
git rm -r scripts/
git rm -r lib/
git rm -r tests/unit/
git rm -r tests/edge-cases/
git rm -r tests/migration/
git rm -r tests/functional/

# Commit removals
git commit -m "refactor: remove deprecated Bash code from active tree (T####)"
```

### Step 5: Update .gitignore
```bash
cat >> .gitignore << 'EOF'

# Legacy Bash Code (archived in archive/bash-legacy/)
scripts/
lib/
tests/unit/
tests/edge-cases/
tests/migration/
tests/functional/
EOF

git add .gitignore
git commit -m "chore: add legacy directories to .gitignore (T####)"
```

## Phase 3: Update Configuration

### Step 6: Update package.json
Edit package.json to update the files array:
- Remove: scripts/, lib/
- Add: archive/bash-legacy/

Update scripts section for TypeScript-only testing.

```bash
git add package.json
git commit -m "chore: update package.json for TypeScript-only (T####)"
```

## Phase 4: Documentation Updates

### Step 7: Update Core Documentation
- README.md - Update installation instructions
- CLAUDE.md - Update development guidelines
- AGENTS.md - Update agent workflow

### Step 8: Create Migration Guide
```bash
mkdir -p docs/migration
cat > docs/migration/bash-to-typescript.mdx << 'EOF'
---
title: Migration from Bash to TypeScript
---

# Migrating from Bash to TypeScript

## Overview
CLEO has completed migration from Bash to TypeScript.

## What Changed

### Before (Bash)
./scripts/add.sh "New Task"

### After (TypeScript)
cleo add "New Task"

## Breaking Changes
1. Binary location: Use 'cleo' instead of './scripts/*.sh'
2. Shebang: Node.js instead of Bash
3. Data store: SQLite with JSON fallback

## Legacy Code
Archived in archive/bash-legacy/ for reference.
EOF
```

```bash
git add README.md CLAUDE.md AGENTS.md docs/
git commit -m "docs: update for TypeScript migration (T####)"
```

## Phase 5: Verification

### Step 9: Test Clean Build
```bash
npm run build
npm test
```

### Step 10: Test Clean Clone
```bash
cd /tmp
git clone <repo-url> cleo-test
cd cleo-test
npm install
npm run build
npm test
```

## Phase 6: Merge

### Step 11: Create PR
```bash
git push origin migration/bash-to-ts-separation
gh pr create --title "refactor: separate Bash legacy code" --body "Migration complete"
```

### Step 12: Tag Release
```bash
git tag -a v2026.3.0 -m "Release: Complete Bash to TypeScript migration"
git push origin v2026.3.0
```

## Success Criteria

- [ ] 86 Bash scripts archived
- [ ] 119 Bash libraries archived
- [ ] scripts/ removed from git
- [ ] lib/ removed from git
- [ ] .gitignore updated
- [ ] package.json updated
- [ ] Documentation updated
- [ ] Clean build succeeds
- [ ] All tests pass
- [ ] PR merged

## Rollback

If needed:
```bash
git checkout archive/bash-legacy -- scripts/ lib/ tests/
git revert <commit-hash>
```
