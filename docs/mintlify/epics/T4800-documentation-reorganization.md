# Documentation Reorganization Epic - T4800

## Executive Summary

This Epic tracks the comprehensive reorganization of CLEO documentation to address:
1. **Documentation sprawl**: 365 files in docs/ + 116 in claudedocs/ = 481 total files
2. **Significant overlap**: ~40-50% content duplication identified
3. **Incomplete GitBook migration**: 316 Mintlify components need conversion
4. **Missing navigation**: 90+ files not referenced in docs.json

## Current State Analysis

### Documentation Inventory

| Directory | Files | Status | Issue |
|-----------|-------|--------|-------|
| `docs/` | 365 | Active | Overlapping directories |
| `claudedocs/` | 116 | Mixed | Duplicate/outdated content |
| **Total** | **481** | | **~40-50% could be consolidated** |

### Critical Overlaps Identified

#### 1. ADR Directories (3 locations)
```
docs/adr/          - 1 file (stale)
docs/adrs/         - 4 files (current)  
docs/archive/adrs/ - 2 files (duplicates)
```
**Action**: Consolidate to `docs/adrs/`

#### 2. Spec Directories (2 locations)
```
docs/specs/                    - 26 files (user-facing specs)
docs/developer/specifications/ - 60+ files (implementation specs)
```
**Issue**: Overlapping topics with different detail levels
**Action**: Define clear boundaries

#### 3. Reference Directory (Orphaned)
```
docs/reference/ - 15 files (NOT in docs.json)
```
**Content duplicates**: api/, guides/, migration/
**Action**: Consolidate into appropriate locations

#### 4. Missing from docs.json (90+ files)
- `docs/architecture/` - 6 files
- `docs/migration/` - 5 files  
- `docs/specs/` - 26 files
- `docs/testing/` - 2 files
- `docs/bugs/` - 1 file

### Top-Level Directory Audit

| Directory | Files | Purpose | Recommendation |
|-----------|-------|---------|----------------|
| `docs/design/` | 1 | Design library | → Move to developer/ |
| `docs/examples/` | 1 | Examples | → Move to guides/ |
| `docs/experiments/` | 2 | Completed experiments | → Archive or delete |
| `docs/integration/` | 3 | Integration guides | → Add to docs.json |
| `docs/lib/` | 1 | Library docs | → Move to developer/ |
| `docs/migration/` | 5 | Migration guides | → Add to docs.json |
| `docs/runbooks/` | 1 | Operational | → Add to docs.json |
| `docs/schema/` | 1 | Schema docs | → Merge with developer/schemas/ |

## Proposed Final Structure (Single Unified Docs)

### End User Documentation (GitBook Main Space)
```
docs/
├── getting-started/          # Installation, quickstart, concepts
│   ├── index.mdx
│   ├── quickstart.mdx
│   ├── installation.mdx
│   └── mcp-server.mdx
│
├── guides/                   # User workflows and how-tos
│   ├── index.mdx
│   ├── project-management.mdx
│   ├── sessions.mdx
│   ├── multi-agent.mdx
│   └── troubleshooting.mdx
│
├── commands/                 # CLI reference (auto-generated from code)
│   ├── index.mdx
│   ├── add.mdx
│   ├── list.mdx
│   └── ... (76 commands)
│
├── api/                      # API reference
│   ├── index.mdx
│   ├── schemas.mdx
│   ├── exit-codes.mdx
│   └── configuration.mdx
│
├── skills/                   # Skills documentation
│   ├── index.mdx
│   └── ...
│
└── changelog/                # Release notes
    └── overview.mdx
```

### Developer/Contributor Documentation (GitBook Same Space, Separate Section)
```
docs/
├── developer/
│   ├── index.mdx             # Developer landing
│   │
│   ├── architecture/         # System design
│   │   ├── index.mdx
│   │   ├── data-flows.mdx
│   │   └── schemas.mdx
│   │
│   ├── specifications/       # Technical specs
│   │   ├── index.mdx
│   │   ├── MCP-GATEWAY.mdx
│   │   └── ...
│   │
│   ├── protocols/            # Protocol definitions
│   │   ├── research.mdx
│   │   └── consensus.mdx
│   │
│   ├── schemas/              # JSON schemas
│   │   ├── error.schema.mdx
│   │   └── sessions.schema.mdx
│   │
│   └── development/          # Development guides
│       ├── code-style.mdx
│       └── documentation-standards.mdx
│
├── adrs/                     # Architecture Decision Records
│   ├── ADR-001-storage-architecture.md
│   └── ...
│
├── specs/                    # User-facing specifications
│   ├── PORTABLE-BRAIN-SPEC.md
│   └── CLEO-OPERATIONS-REFERENCE.md
│
├── migration/                # Migration guides
│   └── ...
│
└── contributing.mdx          # Contribution guidelines
```

### Claudedocs (Historical & Templates)
```
claudedocs/
├── templates/                # Document templates (keep)
├── DEMOS/                    # Demo content (keep)
├── prompts/                  # Agent prompts (keep)
└── archive/                  # Historical archives (review & purge)
```

## Task Breakdown

### Phase 1: Critical Cleanup (Week 1-2)

**T4801: Consolidate ADR directories**
- Delete `docs/adr/` (1 file, stale)
- Delete `docs/archive/adrs/` (2 files, duplicates)
- Keep `docs/adrs/` as canonical
- Update docs.json to include ADRs
- **Impact**: -3 directories, cleaner structure

**T4802: Remove duplicate INSTALLATION-MODES**
- Delete `docs/guides/INSTALLATION-MODES.md`
- Keep `docs/guides/INSTALLATION-MODES.mdx` (in docs.json)
- **Note**: Files have DIFFERENT content
- **Impact**: Remove confusion

**T4803: Add missing directories to docs.json**
- Add `docs/migration/` to Guides tab
- Add `docs/architecture/` to Developer tab
- Add `docs/adrs/` to Developer tab
- Add `docs/testing/` to Developer tab
- **Impact**: 90+ files now accessible

### Phase 2: Content Consolidation (Week 3-4)

**T4804: Consolidate docs/reference/**
- Move `reference/configuration.md` → `api/configuration.mdx`
- Move `reference/exit-codes.md` → `api/exit-codes.mdx`
- Move `reference/troubleshooting.md` → `guides/troubleshooting.md`
- Move `reference/migration-guide.md` → `migration/`
- Delete remaining files
- Delete `docs/reference/` directory
- **Impact**: -15 files, no orphaned content

**T4805: Integrate claudedocs/specs/**
- Review `claudedocs/specs/` files
- Move relevant specs to `docs/specs/`
- Archive or delete outdated specs
- **Impact**: Consolidate specifications

**T4806: Relocate top-level directories**
- Move `docs/design/` → `developer/specifications/`
- Move `docs/examples/` → `guides/`
- Move `docs/experiments/` → `archive/` or delete
- Move `docs/lib/` → `developer/`
- Move `docs/schema/` → `developer/schemas/`
- **Impact**: Cleaner top-level structure

**T4807: Define specs boundaries**
- `docs/specs/` - User-facing, high-level specifications
- `docs/developer/specifications/` - Implementation details, protocols
- Move duplicate files to implementation/ subfolder
- **Impact**: Clear separation of concerns

### Phase 3: GitBook Migration (Week 5-6)

**T4808: Convert 316 Mintlify components**
Priority order:
1. Commands reference docs (high traffic)
2. Getting started docs (user onboarding)
3. Guide docs (user workflows)
4. Developer docs (lower priority)

Conversion mapping:
```
<Info>...</Info> → {% hint style="info" %}...{% endhint %}
<Tip>...</Tip> → {% hint style="success" %}...{% endhint %}
<Note>...</Note> → {% hint style="warning" %}...{% endhint %}
<CodeGroup>...</CodeGroup> → {% tabs %}...{% endtabs %}
<Card>...</Card> → GitBook cards (manual)
```

**T4809: Update SUMMARY.md**
- Regenerate from updated docs.json
- Ensure all navigation is valid
- Test all internal links
- **Impact**: GitBook navigation complete

### Phase 4: Validation & Cleanup (Week 7)

**T4810: Create .drift-config.json**
- Configure detect-drift for project-specific checks
- Set up custom validation rules
- **Impact**: Automated documentation quality checks

**T4811: Archive/delete redundant files**
- Delete identified duplicate files (~30)
- Archive outdated content
- **Impact**: -30 files, ~40-50% size reduction

**T4812: Validate all docs.json links**
- Script to check all paths exist
- Identify broken links
- Fix or remove dead references
- **Impact**: No 404s in documentation

**T4813: Create documentation organization README**
- Document the new structure
- Explain where to add new docs
- Contribution guidelines for docs
- **Impact**: Clear guidance for contributors

## Success Metrics

| Metric | Before | Target | After |
|--------|--------|--------|-------|
| Total files | 481 | < 350 | TBD |
| Files in docs.json | ~40% | 85%+ | TBD |
| Mintlify components | 316 | 0 | TBD |
| detect-drift errors | 1 | 0 | TBD |
| Duplicate content | ~50% | < 10% | TBD |
| Broken links | Unknown | 0 | TBD |

## Risks & Mitigation

### Risk 1: Breaking existing bookmarks
**Mitigation**: 
- Create redirect mapping in GitBook
- Keep old URLs working for 30 days
- Update external references

### Risk 2: Content loss during consolidation
**Mitigation**:
- Backup before any deletions
- Review each file before moving
- Maintain git history

### Risk 3: GitBook conversion incomplete
**Mitigation**:
- Test each converted page
- Validate in GitBook preview
- Fix syntax issues immediately

## Dependencies

- GitBook site must be set up and accessible
- Git Sync enabled for repository
- Team training on new structure
- Review process for doc changes

## Timeline

| Phase | Duration | Tasks | Deliverable |
|-------|----------|-------|-------------|
| Phase 1 | Week 1-2 | T4801-T4803 | Critical cleanup complete |
| Phase 2 | Week 3-4 | T4804-T4807 | Content consolidated |
| Phase 3 | Week 5-6 | T4808-T4809 | GitBook migration |
| Phase 4 | Week 7 | T4810-T4813 | Validation & docs |
| **Total** | **7 weeks** | **13 tasks** | **Clean, organized docs** |

## Notes

- All changes must pass `cleo detect-drift`
- Each task should be a separate PR for review
- Keep detailed changelog of moves/deletions
- Test documentation builds after each phase
- Update AGENTS.md with new doc locations

## Related Documentation

- [GitBook Migration Guide](/docs/architecture/drift-detection)
- [detect-drift command](/docs/commands/detect-drift)
- [Documentation Standards](/docs/developer/development/documentation-standards)
