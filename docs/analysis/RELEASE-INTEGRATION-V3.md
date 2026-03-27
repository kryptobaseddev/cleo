# Release Protocol System: Changesets + VersionGuard Integration

**Date:** 2026-03-25  
**Status:** Implementation Planning  
**Owner:** CLEO Core Team  

## Executive Summary

We have three complementary tools for release management:

1. **Changesets (@changesets/cli)** - Release automation (version selection, changelog authoring, npm publishing)
2. **VersionGuard (@codluv/versionguard)** - Enforcement layer (validation, git hooks, drift detection, changelog format)
3. **CLEO Release Protocol** - Provenance tracking (task-to-release linking, epic completeness, SQLite storage)

This document outlines how they integrate to create a bulletproof release system that works across ANY project.

---

## Tool Responsibilities

### Changesets (@changesets/cli)
**Role:** Release Automation Engine

**Responsibilities:**
- `changeset add` - Capture changes with impact level (major/minor/patch)
- `changeset version` - Bump versions in package.json files
- `changeset publish` - Publish to npm via OIDC
- `changeset tag` - Create git tags
- Generate changelog entries

**Integration Points:**
- Outputs: `.changeset/*.md`, updated `package.json` files, git tags
- Runs in: CI (GitHub Actions), local development

### VersionGuard (@codluv/versionguard)
**Role:** Enforcement & Validation Layer

**Responsibilities:**
- `versionguard validate` - CI gate enforcing rules
- Version format validation (CalVer/SemVer)
- Changelog format compliance (Keep a Changelog)
- Git hook integrity checks
- Version sync across files
- Drift detection

**Key Principle:** VersionGuard NEVER selects versions, authors changelog content, or publishes packages. It validates that rules are followed.

**Configuration:** `.versionguard.yml`
```yaml
versioning:
  type: calver
  format: "YYYY.M.MICRO"

sync:
  files:
    - "packages/core/package.json"
    - "packages/cleo/package.json"
  patterns:
    - regex: '("version"\s*:\s*")(.+?)(")'
      template: '$1{{version}}$3'

changelog:
  enabled: true
  file: "CHANGELOG.md"
  strict: true
  requireEntry: true

git:
  hooks:
    pre-commit: true
    pre-push: true
    post-tag: true
  enforceHooks: true
```

### CLEO Release Protocol
**Role:** Provenance & Task Integration

**Responsibilities:**
- `release.ship` - Composite release operation
- Link releases to CLEO tasks/epics
- Track task completion in release
- Store release metadata in SQLite
- Run release gates (epic completeness, double-listing checks)
- Agent context detection (prevent unauthorized pushes)

**Integration Points:**
- Inputs: Epic IDs, task lists, release notes
- Outputs: `release_manifests` table entries, CHANGELOG.md updates

---

## Known Gotcha: Keep a Changelog Format

**Problem:** Changesets mangles Keep a Changelog format by prepending content above the header.

**Example of the issue:**
```markdown
<!-- Changesets adds content here -->
- Minor bump for feature X

## [2026.3.75] - 2026-03-25
<!-- But Keep a Changelog wants the header first -->
```

**Solution:** VersionGuard can detect and fix this:

1. **Detection Rule:** Check if content exists before first `## [` header
2. **Auto-fix:** Reorder so Keep a Changelog format is preserved
3. **CI Gate:** Fail if format is mangled

**Implementation in VersionGuard:**
```javascript
// .versionguard.yml addition
changelog:
  format: 'keep-a-changelog'
  enforceStructure: true
  sections:
    - 'Added'
    - 'Changed'
    - 'Deprecated'
    - 'Removed'
    - 'Fixed'
    - 'Security'
```

---

## Integration Architecture

### Release Workflow (Happy Path)

```
Developer Workflow:
1. Work on tasks → Complete tasks in CLEO
2. pnpm changeset add → Creates .changeset/*.md
3. Commit changes + changeset
4. Push to GitHub

CI/CD Pipeline:
1. versionguard validate → Checks version sync, changelog format
2. changeset version → Bumps versions, writes changelog
3. [Fix Keep a Changelog format if needed]
4. versionguard validate → Re-checks after changeset version
5. Create Release PR
6. Merge PR
7. changeset publish → Publishes to npm
8. release.ship → Records provenance in CLEO
9. versionguard validate → Final check
```

### New CLEO Operations

Add to `packages/cleo/src/dispatch/registry.ts`:

```typescript
// release.changeset - Create a changeset from CLEO task
{
  gateway: 'mutate',
  domain: 'pipeline',
  operation: 'release.changeset',
  description: 'Create a changeset from a completed CLEO task',
  params: [
    { name: 'taskId', type: 'string', required: true },
    { name: 'impact', type: 'string', required: true }, // major/minor/patch
    { name: 'summary', type: 'string', required: false },
  ]
}

// release.versionguard - Run VersionGuard validation
{
  gateway: 'query',
  domain: 'pipeline',
  operation: 'release.versionguard',
  description: 'Run VersionGuard validation checks',
  params: [
    { name: 'check', type: 'string', required: false }, // specific check name
  ]
}
```

---

## Implementation Phases

### Phase 1: Unblock CI (This Week)
- [x] Commit pnpm-lock.yaml with changesets
- [x] Create JSON type generation script
- [ ] Fix TypeScript JSON schema errors (assign to agent)
- [ ] Add VersionGuard to devDependencies
- [ ] Update CI to run `versionguard validate`

### Phase 2: Core Integration (Next Sprint)
- [ ] Implement `release.changeset` operation
- [ ] Implement `release.versionguard` operation
- [ ] Add Keep a Changelog format fixer to VersionGuard
- [ ] Create hybrid workflow documentation
- [ ] Update `.github/workflows/release.yml`

### Phase 3: CLEO Task Integration (Following Sprint)
- [ ] Auto-generate changesets on task completion
- [ ] Link changesets to CLEO tasks in metadata
- [ ] Epic completeness gate uses changeset data
- [ ] Release notes auto-generated from CLEO task descriptions

### Phase 4: Universal Tooling (Future)
- [ ] Extract integration as reusable CLEO plugin
- [ ] Document for use in ANY project
- [ ] Create project templates with pre-configured setup

---

## GitHub Actions Workflow

```yaml
# .github/workflows/release.yml (updated)
name: Release

on:
  push:
    branches: [main]

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '24'
      
      - run: pnpm install --frozen-lockfile
      
      # Step 1: VersionGuard validation
      - name: Validate with VersionGuard
        run: pnpm versionguard validate
      
      # Step 2: Create Release PR or Publish
      - name: Changesets Action
        uses: changesets/action@v1
        with:
          version: pnpm changeset version
          publish: pnpm changeset publish
          commit: "release: version packages"
          title: "release: version packages"
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          NPM_TOKEN: ${{ secrets.NPM_TOKEN }}
      
      # Step 3: Post-publish CLEO provenance
      - name: Record Release in CLEO
        if: steps.changesets.outputs.published == 'true'
        run: |
          cleo pipeline release ship \
            --version ${{ steps.changesets.outputs.publishedPackages[0].version }} \
            --epic ${{ github.event.head_commit.message }}
      
      # Step 4: Final validation
      - name: Final VersionGuard Check
        run: pnpm versionguard validate
```

---

## Package Scripts

Add to root `package.json`:

```json
{
  "scripts": {
    "versionguard": "versionguard",
    "changeset": "changeset",
    "release": "changeset publish",
    "version-packages": "changeset version",
    "generate:json-types": "node scripts/generate-json-types.mjs"
  }
}
```

---

## Success Metrics

- [ ] CI passes: lint, typecheck, test, versionguard validate
- [ ] Releases are automated via PR (no manual pushing)
- [ ] Changelog follows Keep a Changelog format
- [ ] Versions synced across all package.json files
- [ ] Every release has CLEO provenance record
- [ ] Agent context detection prevents unauthorized pushes
- [ ] Can release from any branch (main/beta/alpha channels)

---

## Documentation Updates Needed

1. **RELEASING.md** - How to create a release
2. **CONTRIBUTING.md** - How to add changesets
3. **CLEO-CLI.md** - New `release.changeset` and `release.versionguard` commands
4. **ARCHITECTURE.md** - How the three tools integrate

---

## Conclusion

This three-tool integration creates a bulletproof release system:

- **Changesets** handles the mechanics (versioning, publishing)
- **VersionGuard** enforces the rules (format, sync, validation)
- **CLEO** provides provenance (task linking, epic tracking)

Together they ensure every release is:
1. ✅ Properly versioned
2. ✅ Documented in changelog
3. ✅ Linked to completed work
4. ✅ Validated before publishing
5. ✅ Traceable back to tasks

**Next Steps:**
1. Pick up EPIC-TYPESCRIPT-JSON-SCHEMA-FIX to unblock CI
2. Implement Phase 1 (this week)
3. Schedule Phase 2 for next sprint
