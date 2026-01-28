# Release Version Management Implementation Report

**Purpose**: Track implementation progress against the Release Version Management Specification
**Related Spec**: [RELEASE-VERSION-MANAGEMENT-SPEC.md](RELEASE-VERSION-MANAGEMENT-SPEC.md) v2.0.0
**Last Updated**: 2025-12-18

---

## Summary

| Metric | Value |
|--------|-------|
| Overall Progress | 0% |
| Components Complete | 0/10 |
| Current Phase | Research Complete, Spec v2.0.0 Finalized |
| Target Release | v0.20.0 |

---

## Component Status

| Component | Status | Notes |
|-----------|--------|-------|
| Specification v2.0.0 | COMPLETE | 4-state lifecycle, VERSION integration, git tags |
| Config Schema (releases section) | PENDING | Add to config.schema.json |
| Release Registry (project.releases) | PENDING | Add to todo.schema.json v2.4 |
| Task Fields (targetRelease, shippedRelease) | PENDING | Add to task definition |
| CLI Commands (release subcommand) | PENDING | 9 commands total |
| Validation Library (lib/release.sh) | PENDING | Core release functions |
| Auto-transition Logic | PENDING | planning→development on focus |
| VERSION File Integration | PENDING | Suggest, bump on ship |
| Git Tag Integration | PENDING | Create tag on ship |
| Migration Tool (migrate-labels) | PENDING | Label → release migration |
| Tests | PENDING | Unit + integration |

---

## Research Findings Summary

### Phase 1: Initial Research (Complete)

Three specialized agents analyzed this feature:

1. **Deep Research Agent**: Industry patterns (Linear, GitHub, Jira, semver)
2. **System Architect**: Schema design and normalization analysis
3. **Requirements Analyst**: Devil's advocate challenge and MoSCoW requirements

**Key Consensus Points (All Agents Agreed):**

| Finding | Agreement | Rationale |
|---------|-----------|-----------|
| Separate Release entity necessary | All agents | Labels insufficient for lifecycle tracking |
| Hybrid approach (registry + task fields) | All agents | Mirrors existing `phases` pattern |
| Two task fields (targetRelease, shippedRelease) | All agents | Separates intent from reality |
| Immutability after release | All agents | Historical accuracy, audit trails |
| Referential integrity validation | All agents | Anti-hallucination for LLM agents |
| Labels insufficient for lifecycle | All agents | No state machine, no timestamps |

**MoSCoW Requirements Summary (Initial):**

| Priority | Count | Examples |
|----------|-------|----------|
| MUST | 10 | Release entity, lifecycle states, validation commands |
| SHOULD | 7 | Migration command, scope change warnings |
| COULD | 5 | Changelog export, release dashboard |
| WON'T (v1) | 7 | Git integration, CI/CD, branch tracking |

### Phase 2: Refinement Discussion (Complete - 2025-12-18)

User-driven refinement session addressing real-world observations:

**Problem Observed**: 42+ tasks with stale version labels (v0.17.0 on pending tasks when v0.18.1 is current)

**Key Decisions Made**:

| Topic | Decision | Rationale |
|-------|----------|-----------|
| Lifecycle states | 4 states (removed stabilization) | Stabilization is workflow discipline, not system state |
| Planning→Development | Automatic on focus | Reduces friction, reflects reality |
| Epic handling | No shippedRelease on epics | Epics are organizational, children ship individually |
| VERSION integration | Suggest NEXT version, bump on ship | Prevents drift between tasks and VERSION file |
| Git tags | Included in v1, prompt-based | Low complexity, high value |
| Config location | .cleo/config.json | Consistent with existing config pattern |
| Release scope | Empty releases allowed | Industry standard (GitHub, Jira, Linear) |
| Opt-in + Strict | Disabled by default, strict once enabled | Gradual adoption path |

**MoSCoW Requirements (Updated After Refinement):**

| Priority | Count | Key Items | Changes from Initial |
|----------|-------|-----------|----------------------|
| MUST | 12 | Release entity, 4-state lifecycle, task fields, validation, migration | +2 (migration tool, epic handling) |
| SHOULD | 8 | VERSION bump, git tags, auto-transition, suggest command | +1 (git tags moved from WON'T) |
| COULD | 4 | Changelog export, burndown charts | -1 |
| WON'T (v1) | 5 | CI/CD, branch tracking, auto-push, rollback | -2 (git tags, VERSION moved to SHOULD) |

---

## Implementation Phases

### Phase 1: Specification - COMPLETE

- [x] Research industry patterns (Linear, GitHub, Jira)
- [x] Schema design with multi-agent analysis
- [x] Requirements analysis with MoSCoW prioritization
- [x] Devil's advocate challenge of assumptions
- [x] Draft specification v1.0.0
- [x] User refinement discussion (2025-12-18)
- [x] Spec v2.0.0 with 4-state lifecycle, VERSION/git integration

### Phase 2: Schema (v2.4) - PENDING

- [ ] Add `releases` section to config.schema.json
- [ ] Add `project.releases` to todo.schema.json
- [ ] Add `project.releaseHistory` to todo.schema.json
- [ ] Add `targetRelease` field to task definition
- [ ] Add `shippedRelease` field to task definition (with epic exclusion)
- [ ] Add release exit codes to lib/exit-codes.sh (30-35)
- [ ] Add release error codes to lib/error-json.sh
- [ ] Bump schema version to v2.4

### Phase 3: Core Library - PENDING

- [ ] Create lib/release.sh library
- [ ] Implement `release_exists()` function
- [ ] Implement `release_validate()` function
- [ ] Implement `release_create()` function
- [ ] Implement `release_transition()` function
- [ ] Implement `release_ship()` function
- [ ] Implement auto-transition logic (planning→development on focus)
- [ ] Integrate with lib/focus.sh for auto-transition trigger

### Phase 4: VERSION Integration - PENDING

- [ ] Implement VERSION file detection
- [ ] Implement semver parsing and comparison
- [ ] Implement `release_suggest()` - analyze tasks, suggest bump
- [ ] Implement VERSION file update in ship flow
- [ ] Add config options: `versionFile`, `versionBump.mode`

### Phase 5: Git Integration - PENDING

- [ ] Implement git repository detection
- [ ] Implement `git_create_tag()` function
- [ ] Integrate tag creation into ship flow
- [ ] Add config options: `gitIntegration.createTag`, `gitIntegration.tagPrefix`
- [ ] Handle non-git projects gracefully

### Phase 6: CLI Commands - PENDING

- [ ] `ct release create <version>` - Register new release
- [ ] `ct release list [--status]` - List releases
- [ ] `ct release show <version>` - Release details + tasks
- [ ] `ct release exists <version>` - Check existence
- [ ] `ct release status <version> <status>` - Update lifecycle
- [ ] `ct release ship <version>` - Full ship workflow
- [ ] `ct release delete <version>` - Remove release
- [ ] `ct release suggest` - Suggest next version
- [ ] `ct release migrate-labels` - Label migration tool
- [ ] Update `ct add` with `--target-release` flag
- [ ] Update `ct update` with `--target-release` flag
- [ ] Update `ct list` with `--target-release`, `--shipped-release`, `--no-release` filters

### Phase 7: Migration Tool - PENDING

- [ ] Implement label pattern detection (`^v?[0-9]+\.[0-9]+\.[0-9]+`)
- [ ] Implement done task → shippedRelease inference
- [ ] Implement pending task → targetRelease assignment
- [ ] Implement dual label resolution (keep highest)
- [ ] Implement `--dry-run` mode with preview
- [ ] Implement `--execute` mode with backup
- [ ] Handle edge cases (tasks with no version labels)

### Phase 8: Testing - PENDING

- [ ] Unit tests for lib/release.sh functions
- [ ] Unit tests for VERSION integration
- [ ] Unit tests for git integration
- [ ] Integration tests for CLI commands
- [ ] Integration tests for auto-transition
- [ ] Integration tests for ship workflow
- [ ] Migration tool tests with fixtures
- [ ] Exit code validation tests
- [ ] JSON output schema validation tests

### Phase 9: Documentation - PENDING

- [ ] Create docs/commands/release.md
- [ ] Update docs/reference/command-reference.md
- [ ] Update docs/architecture/SCHEMAS.md for v2.4
- [ ] Create docs/migration/v2.4.0-migration-guide.md
- [ ] Update CLAUDE.md injection template
- [ ] Update QUICK-REFERENCE.md

---

## Blockers

| Issue | Impact | Mitigation |
|-------|--------|------------|
| T382 Config System | Config schema design | Coordinate with config system work |
| Hierarchy spec (v0.17.0) | Epic type field needed | Can proceed, epic check uses label fallback |

---

## Dependencies

| Task | Dependency | Status |
|------|------------|--------|
| Release feature | Config system (T382) | Pending |
| shippedRelease epic check | Hierarchy `type` field | In progress (v0.17.0) |
| Schema v2.4 | Schema v2.3 (hierarchy) | Complete |

---

## Test Plan

### Unit Tests (lib/release.sh)

| Test | Description |
|------|-------------|
| `test_release_exists` | Check existence validation |
| `test_release_create` | Create with valid/invalid versions |
| `test_release_transition` | Valid and invalid state transitions |
| `test_release_ship` | Full ship workflow |
| `test_release_auto_transition` | Focus triggers planning→development |
| `test_epic_shipped_blocked` | Epics cannot have shippedRelease |

### Integration Tests

| Test | Description |
|------|-------------|
| `test_release_workflow` | Full create→develop→ship cycle |
| `test_version_bump` | VERSION file update on ship |
| `test_git_tag` | Git tag creation |
| `test_migrate_labels` | Label migration with dry-run |
| `test_task_release_filter` | List filtering by release |

---

## How to Update

1. Update task status when work begins
2. Update Last Updated date
3. Move items between phases as appropriate
4. Run `ct validate` after JSON modifications

---

## Version History

| Date | Change |
|------|--------|
| 2025-12-18 | Spec v2.0.0: 4-state lifecycle, auto-transitions, VERSION/git integration |
| 2025-12-18 | Initial report created after research phase |

---

## Related Tasks

| Task ID | Title | Status |
|---------|-------|--------|
| T448 | Research: Release Version Management System | Done |
| T382 | Config System Integration | Pending |
| T328 | Hierarchy Enhancement (type field) | Pending |

---

*Implementation tracking for [RELEASE-VERSION-MANAGEMENT-SPEC.md](RELEASE-VERSION-MANAGEMENT-SPEC.md) v2.0.0*
