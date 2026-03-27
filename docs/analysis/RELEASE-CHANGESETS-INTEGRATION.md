# Release Protocol System vs Changesets CLI - Analysis

**Date:** 2026-03-25  
**Status:** Integration Planning  

## Current State Analysis

### CLEO Release Protocol System

**Location:** `packages/cleo/src/dispatch/engines/release-engine.ts`  
**Domain:** `pipeline` (release.* operations)  
**Registry:** `packages/cleo/src/dispatch/registry.ts` (lines 1980-2033)

**Operations:**
- `release.ship` - Composite operation (validates gates → writes CHANGELOG → git commit/tag/push → records provenance)
- `release.list` - Query releases from release_manifests table
- `release.show` - Show release details
- `release.cancel` - Cancel a release
- `release.rollback` - Rollback a release

**Provenance Tracking:**
- Stores releases in `release_manifests` SQLite table
- Links releases to epics via `epicId`
- Tracks tasks included in release
- Records changelog entries

**Changelog Generation:**
- Uses `generateReleaseChangelog()` from core
- Writes to `CHANGELOG.md` at project root
- Generates git commits with release metadata
- Creates annotated git tags

**Gate System:**
- `runReleaseGates()` validates release readiness
- Checks epic completeness
- Checks for double-listing
- Validates version format

### Changesets CLI

**Location:** `.changeset/` directory (newly added)  
**Package:** `@changesets/cli` v2.30.0  
**Config:** `.changeset/config.json`

**Workflow:**
1. `changeset add` - Create changeset file describing changes
2. `changeset version` - Bump versions based on changesets
3. `changeset publish` - Publish to npm
4. `changeset tag` - Create git tags

**Features:**
- Per-package versioning in monorepos
- Semantic versioning (major/minor/patch)
- Automatic changelog generation
- GitHub Actions integration
- Bulletproof provenance (widely used, battle-tested)

## Gap Analysis

| Feature | CLEO Release System | Changesets CLI | Gap |
|---------|-------------------|----------------|-----|
| Provenance | SQLite + Git | Git only | CLEO has better task integration |
| Changelog | Manual/Generated | Auto-generated | Changesets has better formatting |
| Versioning | CalVer only | SemVer + CalVer | Changesets more flexible |
| Monorepo | Limited support | Excellent | Changesets wins here |
| CI Integration | None | GitHub Actions workflow | Changesets has better CI |
| Task Integration | Native | None | CLEO wins here |
| Adoption | Internal only | Industry standard | Changesets more trusted |

## Integration Strategy

### Option 1: CLEO Release System + Changesets (Hybrid)

**Approach:** Keep both systems, integrate them

**Workflow:**
1. Developer creates changeset: `pnpm changeset add`
2. When ready to release:
   - `release.ship` calls `changeset version` to bump versions
   - `release.ship` calls `changeset publish` for npm
   - CLEO records provenance in SQLite
   - CLEO creates git tags with epic metadata

**Pros:**
- Best of both worlds
- Task integration preserved
- Industry-standard provenance
- Monorepo versioning works

**Cons:**
- More complex
- Two systems to maintain
- Potential for drift

### Option 2: Replace CLEO Changelog with Changesets

**Approach:** Use changesets for versioning/changelog, CLEO for provenance

**Changes:**
- Remove `generateReleaseChangelog()` from CLEO
- Use `.changeset/*.md` files instead of release_manifests
- CLEO operations query changesets for provenance
- Keep release gates (they're valuable)

**Pros:**
- Simpler architecture
- Better changelog formatting
- Standard tooling

**Cons:**
- Loses SQLite-based provenance queries
- Migration effort
- Task-to-release linking needs rework

### Option 3: Enhance CLEO Release to Match Changesets

**Approach:** Keep CLEO system, add missing features

**Changes:**
- Add `.changeset/` style changeset files
- Implement `changeset version` logic in CLEO
- Create GitHub Actions workflow
- Add monorepo versioning

**Pros:**
- Full control
- Native CLEO integration
- No external dependencies

**Cons:**
- Reinventing the wheel
- High maintenance burden
- Not industry standard

## Recommendation: Option 1 (Hybrid with Changesets)

### Implementation Plan

#### Phase 1: Unblock CI (Immediate)
- [ ] Fix pnpm-lock.yaml (commit changes)
- [ ] Fix TypeScript JSON schema errors (separate epic)
- [ ] Skip typecheck in CI temporarily if needed

#### Phase 2: Integration (Next Sprint)
- [ ] Create `release.changeset` operation in CLEO
- [ ] Add changeset generation to task completion workflow
- [ ] Integrate `changeset version` into `release.ship`
- [ ] Update CI to use changesets GitHub Action

#### Phase 3: Migration (Future)
- [ ] Migrate existing CHANGELOG.md format
- [ ] Add changeset linting to CI
- [ ] Document new workflow

### Files to Create/Modify

```
.changeset/config.json          # Already exists
.github/workflows/release.yml   # Add changesets action
packages/cleo/src/dispatch/engines/release-engine.ts
  └─ Add changesetVersion(), changesetPublish() wrappers
packages/cleo/src/dispatch/registry.ts
  └─ Add release.changeset operation
```

### New CLEO Operations

```typescript
// release.changeset - Create a changeset from task
{
  domain: 'pipeline',
  operation: 'release.changeset',
  gateway: 'mutate',
  params: ['taskId', 'summary', 'packages[]', 'impact'] // major/minor/patch
}

// release.version - Bump versions using changesets
{
  domain: 'pipeline',
  operation: 'release.version',
  gateway: 'mutate',
  params: ['snapshot?', 'since?']
}
```

### CI/CD Integration

```yaml
# .github/workflows/release.yml additions
- name: Create Release Pull Request or Publish
  uses: changesets/action@v1
  with:
    publish: pnpm release
    version: pnpm version-packages
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    NPM_TOKEN: ${{ secrets.NPM_TOKEN }}
```

## Conclusion

The CLEO release system has excellent **task integration** and **provenance tracking**, but lacks:
- Industry-standard changelog formatting
- Monorepo versioning
- CI/CD integration

Changesets CLI provides:
- Bulletproof versioning
- Excellent monorepo support
- GitHub Actions integration
- Wide adoption

**Recommendation:** Integrate changesets into CLEO's release workflow rather than replacing it. This preserves CLEO's task-level provenance while gaining changesets' versioning power.

## Next Steps

1. **Immediate:** Commit lockfile to fix CI install
2. **Today:** Create epic for JSON schema type errors
3. **This week:** Implement Phase 1 integration
4. **Next sprint:** Full hybrid workflow
