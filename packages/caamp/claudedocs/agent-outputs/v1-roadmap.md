# CAAMP v1.0.0 Roadmap

**Task**: Epic Decomposition for v1.0.0
**Epic**: T038
**Date**: 2026-02-11
**Status**: complete

---

## Summary

CAAMP v1.0.0 production stability release decomposed into 5 sub-epics with 46 atomic tasks organized into 3 execution waves. Based on analysis of 4 audit reports and gap analysis, this roadmap addresses all critical stability criteria for v1.0.0 release.

---

## Epic Structure

### Master Epic
- **T038**: CAAMP v1.0.0 - Production Stability Release

### Sub-Epics (5)

#### Wave 0: Critical Fixes (no dependencies)
- **T039**: Critical Fixes - Error Handling & Documentation

#### Wave 1: Parallel Development
- **T049**: Test Coverage to 80%+ (depends on T039)
- **T062**: CI/CD Hardening (depends on T039)

#### Wave 2: Documentation
- **T070**: Documentation Completion (depends on T039, T049, T062)

#### Wave 3: Release
- **T078**: Release Preparation (depends on T039, T049, T062, T070)

---

## Task Tree with IDs

```
T038 CAAMP v1.0.0 - Production Stability Release
│
├─ T039 [Wave 0] Critical Fixes - Error Handling & Documentation
│  ├─ T040 Add global error handler to cli.ts
│  ├─ T041 Fix README.md stale counts
│  ├─ T042 Fix doctor command hardcoded version
│  ├─ T043 Add network error UX messages
│  ├─ T044 Add fetch timeouts to all network calls
│  ├─ T045 Remove invalid providers: supermaven and sweep
│  ├─ T046 Fix MarketplaceResult TSDoc comment
│  ├─ T047 Remove unused @clack/prompts dependency or implement
│  └─ T048 Extract hardcoded ~/.agents path to shared constant
│
├─ T049 [Wave 1] Test Coverage to 80%+ (depends: T039)
│  ├─ T050 Add unit tests for MCP installer
│  ├─ T051 Add unit tests for MCP transforms
│  ├─ T052 Add unit tests for detection engine
│  ├─ T053 Add unit tests for GitHub/GitLab fetchers
│  ├─ T054 Add unit tests for doctor command
│  ├─ T055 Add unit tests for logger
│  ├─ T056 Add unit tests for lock-utils
│  ├─ T057 Fix flaky installer.test.ts tmpdir race condition
│  ├─ T058 Add integration tests for full skill install flow
│  ├─ T059 Add integration tests for full MCP install flow
│  ├─ T060 Add integration tests for CLI commands
│  └─ T061 Set up coverage reporting with vitest
│
├─ T062 [Wave 1] CI/CD Hardening (depends: T039)
│  ├─ T063 Add ESLint or Biome linter with npm run lint
│  ├─ T064 Add multi-OS CI matrix
│  ├─ T065 Add npm audit step to CI
│  ├─ T066 Add Dependabot or Renovate for dependency updates
│  ├─ T067 Add coverage reporting to CI (depends: T061)
│  ├─ T068 Set up branch protection rules on main
│  └─ T069 Add CodeQL or similar security scanning
│
├─ T070 [Wave 2] Documentation Completion (depends: T039, T049, T062)
│  ├─ T071 Create CONTRIBUTING.md
│  ├─ T072 Create per-provider configuration guide
│  ├─ T073 Create SECURITY.md
│  ├─ T074 Create migration guide
│  ├─ T075 Add --help examples to all CLI commands
│  ├─ T076 Create troubleshooting guide
│  └─ T077 Generate and publish TypeDoc API docs to GitHub Pages
│
└─ T078 [Wave 3] Release Preparation (depends: T039, T049, T062, T070)
   ├─ T079 Final audit: run all 4 validation agents again
   ├─ T080 Version bump to 1.0.0
   ├─ T081 Write CHANGELOG.md v1.0.0 entry
   ├─ T082 Create GitHub release v1.0.0
   ├─ T083 Verify npm publish
   ├─ T084 Update GAP-ANALYSIS.md with v1.0.0 shipped status
   └─ T085 Announce release
```

---

## Wave Execution Plan

### Wave 0: Critical Fixes (9 tasks)
**Dependencies**: None
**Can start immediately**

All tasks in T039 can be executed in parallel:
- T040: Global error handler (small)
- T041: README updates (small)
- T042: Doctor version fix (small)
- T043: Network error messages (medium)
- T044: Fetch timeouts (medium)
- T045: Remove invalid providers (small)
- T046: TSDoc fix (small)
- T047: Remove/implement @clack/prompts (small)
- T048: Extract hardcoded path (small)

**Estimated scope**: 7 small tasks + 2 medium tasks = **small to medium epic**

---

### Wave 1: Parallel Development (19 tasks)
**Dependencies**: Wave 0 must complete
**Two parallel tracks**

#### Track A: Test Coverage (T049, 12 tasks)
All tasks except T058-T061 can be executed in parallel:
- T050: MCP installer tests (medium)
- T051: MCP transforms tests (medium)
- T052: Detection engine tests (medium)
- T053: GitHub/GitLab fetcher tests (medium)
- T054: Doctor command tests (medium)
- T055: Logger tests (small)
- T056: Lock-utils tests (small)
- T057: Fix flaky test (small)

Then sequentially:
- T058: Integration tests - skill install (medium)
- T059: Integration tests - MCP install (medium)
- T060: Integration tests - CLI commands (large)
- T061: Coverage reporting setup (small)

**Estimated scope**: 5 medium + 3 small + 1 large + 3 integration tests = **large epic**

#### Track B: CI/CD Hardening (T062, 7 tasks)
Tasks can be executed mostly in parallel:
- T063: Add linter (medium)
- T064: Multi-OS CI (medium)
- T065: npm audit step (small)
- T066: Dependabot setup (small)
- T068: Branch protection (small - manual GitHub settings)
- T069: CodeQL scanning (medium)

Then sequentially (after T061 from Track A):
- T067: Coverage reporting to CI (small, depends on T061)

**Estimated scope**: 3 medium + 4 small = **medium epic**

---

### Wave 2: Documentation (7 tasks)
**Dependencies**: Waves 0 and 1 must complete
**Can execute all tasks in parallel**

- T071: CONTRIBUTING.md (medium)
- T072: Provider config guide (large)
- T073: SECURITY.md (small)
- T074: Migration guide (medium)
- T075: CLI --help examples (medium)
- T076: Troubleshooting guide (medium)
- T077: TypeDoc to GitHub Pages (small)

**Estimated scope**: 1 large + 4 medium + 2 small = **medium to large epic**

---

### Wave 3: Release (7 tasks)
**Dependencies**: All previous waves must complete
**Sequential execution required**

1. T079: Final audit (medium)
2. T080: Version bump (small)
3. T081: CHANGELOG entry (medium)
4. T082: GitHub release (small)
5. T083: Verify npm publish (small)
6. T084: Update GAP-ANALYSIS (small)
7. T085: Announce release (small)

**Estimated scope**: 2 medium + 5 small = **small to medium epic**

---

## Dependency Graph

```
Wave 0: Critical Fixes
┌─────────────────────────────┐
│ T039 (Critical Fixes)       │
│   ├─ T040 (9 parallel tasks)│
│   ├─ T041                   │
│   ├─ T042                   │
│   ├─ T043                   │
│   ├─ T044                   │
│   ├─ T045                   │
│   ├─ T046                   │
│   ├─ T047                   │
│   └─ T048                   │
└─────────────────────────────┘
         │
         ├─────────────────────────────────┐
         │                                 │
         ▼                                 ▼
Wave 1: Parallel Tracks
┌──────────────────────────┐  ┌──────────────────────────┐
│ T049 (Test Coverage)     │  │ T062 (CI/CD Hardening)   │
│   ├─ T050-T057 (parallel)│  │   ├─ T063-T066 (parallel)│
│   ├─ T058-T060 (sequence)│  │   ├─ T068-T069 (parallel)│
│   └─ T061 (coverage setup)│  │   └─ T067 ──depends on──┤
└──────────────────────────┘  └──────────────────────────┘
         │                                 │
         │                T061 ────────────┘
         │
         ├─────────────────────────────────┤
         │                                 │
         ▼                                 ▼
Wave 2: Documentation
┌─────────────────────────────────────────┐
│ T070 (Documentation Completion)         │
│   ├─ T071-T077 (all parallel)          │
└─────────────────────────────────────────┘
         │
         ▼
Wave 3: Release
┌─────────────────────────────────────────┐
│ T078 (Release Preparation)              │
│   ├─ T079 (audit)                       │
│   ├─ T080 (version bump)                │
│   ├─ T081 (changelog)                   │
│   ├─ T082 (GitHub release)              │
│   ├─ T083 (npm verify)                  │
│   ├─ T084 (update gap analysis)         │
│   └─ T085 (announce)                    │
└─────────────────────────────────────────┘
```

---

## Scope Estimates

### By Epic
| Epic | Tasks | Small | Medium | Large | Overall |
|------|-------|-------|--------|-------|---------|
| T039 | 9 | 7 | 2 | 0 | Small-Medium |
| T049 | 12 | 3 | 5 | 1 | Large |
| T062 | 7 | 4 | 3 | 0 | Medium |
| T070 | 7 | 2 | 4 | 1 | Medium-Large |
| T078 | 7 | 5 | 2 | 0 | Small-Medium |
| **Total** | **42** | **21** | **16** | **2** | **Large** |

### By Wave
| Wave | Epics | Tasks | Scope |
|------|-------|-------|-------|
| Wave 0 | 1 | 9 | Small-Medium |
| Wave 1 | 2 | 19 | Large |
| Wave 2 | 1 | 7 | Medium-Large |
| Wave 3 | 1 | 7 | Small-Medium |
| **Total** | **5** | **42** | **Large** |

---

## Key Milestones

### Milestone 1: Foundation Stable
**After Wave 0 completes**
- All critical errors fixed
- User-facing documentation accurate
- No invalid providers in registry
- All hardcoded paths extracted

### Milestone 2: Quality Gates Met
**After Wave 1 completes**
- 80%+ test coverage achieved
- Multi-OS CI passing
- Security scanning enabled
- Branch protection active

### Milestone 3: Production Ready
**After Wave 2 completes**
- Community contribution process documented
- All providers have config guides
- Migration path clear
- Troubleshooting resources available

### Milestone 4: v1.0.0 Shipped
**After Wave 3 completes**
- All stability criteria met
- npm package published
- GitHub release created
- Community announcement sent

---

## Risk Mitigation

### High Risk Items
1. **Integration test stability**: May discover new edge cases
   - Mitigation: Run integration tests early and often in Wave 1
2. **Multi-OS CI failures**: Windows/macOS may have platform-specific bugs
   - Mitigation: Prioritize T064 early in Wave 1 to surface issues
3. **Coverage threshold**: May not reach 80% with current test plan
   - Mitigation: Measure coverage after each test task, add tests as needed

### Medium Risk Items
1. **Documentation completeness**: Provider guide may be time-consuming
   - Mitigation: Prioritize top 10 providers, defer others to v1.1
2. **Branch protection conflicts**: May block rapid iteration
   - Mitigation: Keep T068 late in Wave 1, after most code changes done

---

## Success Criteria

### v1.0.0 Release Criteria (from GAP-ANALYSIS.md Section 7)
- [x] 46 providers in registry (already met)
- [ ] 80% line coverage across all core modules
- [ ] 100% of public API functions have unit tests
- [ ] Integration test suite for all CLI commands
- [ ] Cross-platform CI (Linux, macOS, Windows)
- [ ] API reference from TSDoc (already generated, needs publishing)
- [ ] Per-provider configuration guide
- [ ] Migration guide
- [ ] Contributing guidelines
- [ ] Security disclosure policy
- [ ] Branch protection and PR review process
- [ ] All critical audit findings resolved

---

## Next Steps

1. **Start Wave 0**: Begin with T039 tasks (all can run in parallel)
2. **Monitor progress**: Use `ct session status` to track active work
3. **Update dependencies**: Mark tasks complete with `ct done <id>` to unblock dependents
4. **Track blockers**: Document any issues in task notes
5. **Final validation**: Run T079 (final audit) to verify all criteria met

---

## References

- **Master Epic**: T038
- **Audit Reports**:
  - `claudedocs/agent-outputs/stability-validation.md`
  - `claudedocs/agent-outputs/code-quality-audit.md`
  - `claudedocs/agent-outputs/api-surface-audit.md`
  - `claudedocs/agent-outputs/cicd-audit.md`
- **Gap Analysis**: `claudedocs/GAP-ANALYSIS.md` Section 7
- **Current Version**: v0.3.0
- **Target Version**: v1.0.0
