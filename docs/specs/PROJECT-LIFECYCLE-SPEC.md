# Project Lifecycle & Task Management Specification

**Version**: 1.0.0
**Status**: Draft
**Last Updated**: 2025-12-22

---

## Executive Summary

cleo is a task management system designed for software projects across their entire lifecycle. It works for **greenfield** (new) projects, **brownfield** (existing) projects, and **grayfield** (hybrid) transitions.

### The Two-Dimensional Model

```
                    PHASES (Lifecycle Time →)
                    ┌─────────┬─────────┬─────────┬─────────┬─────────┐
                    │ setup   │ core    │ testing │ polish  │ maint.  │
             ┌──────┼─────────┼─────────┼─────────┼─────────┼─────────┤
             │ Epic │ [tasks] │ [tasks] │ [tasks] │ [tasks] │ [tasks] │
    EPICS    │  A   │         │         │         │         │         │
  (Vertical) ├──────┼─────────┼─────────┼─────────┼─────────┼─────────┤
             │ Epic │ [tasks] │ [tasks] │ [tasks] │ [tasks] │ [tasks] │
             │  B   │         │         │         │         │         │
             └──────┴─────────┴─────────┴─────────┴─────────┴─────────┘
```

- **PHASES** = WHERE you are in the project lifecycle (horizontal, time-based)
- **EPICS** = WHAT capabilities you're building (vertical, feature-based)
- **TASKS** = HOW you build them (at the intersection)

---

## Part 1: Conceptual Framework

### 1.1 The Lifecycle Continuum

All projects follow the same lifecycle stages, but execute them differently:

```
┌──────────────────────────────────────────────────────────────────────┐
│                         PROJECT LIFECYCLE                            │
├──────────┬──────────┬──────────┬──────────┬──────────┬──────────────┤
│ Discovery│ Planning │ Design   │ Build    │ Test     │ Release      │
│          │          │          │          │          │              │
│ "What?"  │ "How?"   │ "Shape?" │ "Make!"  │ "Works?" │ "Ship!"      │
├──────────┴──────────┴──────────┴──────────┴──────────┴──────────────┤
│                                  ↓                                   │
├──────────────────────────────────────────────────────────────────────┤
│                     Operate ←→ Improve (Continuous)                  │
│                     "Run it"    "Better it"                          │
└──────────────────────────────────────────────────────────────────────┘
```

### 1.2 Mapping to cleo Phases

| Lifecycle Stage | cleo Phase | Primary Activities |
|-----------------|-------------------|-------------------|
| Discovery | `setup` | Define problem, identify users, validate need |
| Planning | `setup` | Choose stack, define architecture, create roadmap |
| Design | `setup` / `core` | UX flows, data models, API contracts |
| Build | `core` | Implement features, write code |
| Test | `testing` | Unit tests, integration tests, QA |
| Release | `polish` | Deployment prep, optimization, documentation |
| Operate | `maintenance` | Monitoring, incident response, support |
| Improve | `maintenance` | Feedback loops, performance tuning, iteration |

### 1.3 The Key Insight

> **After first release, everything becomes brownfield.**

Even greenfield projects accumulate:
- Users who depend on behavior
- Data that must be preserved
- Constraints that limit changes

The lifecycle **never stops**. It loops: Operate → Improve → Discovery → Build → Release → Operate...

---

## Part 2: Phase Definitions

### 2.1 Setup Phase

**Purpose**: Foundation and preparation

**Activities**:
- Project initialization
- Dependency setup
- Architecture decisions
- Initial scaffolding
- Research and discovery
- Technical spikes

**Typical Task Patterns**:
```
T001: Initialize project structure
T002: Configure development environment
T003: Define data models
T004: Research authentication approaches
T005: Create architectural decision records
```

**Exit Criteria**: Project can build and run (even if empty)

---

### 2.2 Core Phase

**Purpose**: Primary development and feature building

**Activities**:
- Feature implementation
- API development
- UI/UX implementation
- Integration work
- Refactoring (when part of feature work)

**Typical Task Patterns**:
```
T010: Implement user registration endpoint
T011: Create login form component
T012: Add JWT middleware
T013: Integrate payment provider
T014: Build dashboard view
```

**Exit Criteria**: Features functionally complete (not necessarily polished)

---

### 2.3 Testing Phase

**Purpose**: Validation and quality assurance

**Activities**:
- Test creation and execution
- Bug fixing
- Performance testing
- Security audits
- Regression testing

**Typical Task Patterns**:
```
T020: Write unit tests for auth module
T021: Create integration test suite
T022: Fix: Login fails with special characters
T023: Performance test API endpoints
T024: Security review of auth flow
```

**Exit Criteria**: Quality gates pass, no critical bugs

---

### 2.4 Polish Phase

**Purpose**: Release preparation and optimization

**Activities**:
- Documentation
- UX refinement
- Performance optimization
- Accessibility improvements
- Release preparation

**Typical Task Patterns**:
```
T030: Write API documentation
T031: Improve loading states
T032: Optimize database queries
T033: Add error messages for edge cases
T034: Prepare deployment scripts
```

**Exit Criteria**: Ready for production release

---

### 2.5 Maintenance Phase

**Purpose**: Ongoing operation and improvement

**Activities**:
- Bug fixes
- Monitoring and alerting
- Performance tuning
- Incremental improvements
- Technical debt reduction

**Typical Task Patterns**:
```
T040: Fix: Timeout on large exports
T041: Add monitoring for payment failures
T042: Reduce login latency
T043: Upgrade dependency versions
T044: Refactor legacy auth code
```

**Exit Criteria**: None (continuous)

---

## Part 3: Project Context

### 3.1 Greenfield Projects

**Definition**: Building on empty land. No existing code, users, or constraints.

**Characteristics**:
- Full design freedom
- Linear phase progression
- Build-focused tasks
- Epics represent capability creation

**Phase Flow**:
```
setup ──→ core ──→ testing ──→ polish ──→ maintenance
  │         │         │          │            │
  ▼         ▼         ▼          ▼            ▼
 plan     build     test      release      operate
```

**Epic Naming Convention**:
```
EPIC: User Authentication System
EPIC: Payment Processing
EPIC: Admin Dashboard
EPIC: Notification Service
```

**Recommended Labels**: `greenfield`, `capability-*`

---

### 3.2 Brownfield Projects

**Definition**: Renovating a live building. Existing code, users, and constraints.

**Characteristics**:
- Constraint-driven design
- Non-linear phase work (core + testing + maintenance simultaneous)
- Risk mitigation tasks
- Epics represent change or improvement

**Phase Flow**:
```
     ┌──────────────────────────────────┐
     │                                  │
     ▼                                  │
   setup ──→ core ◄──► testing ──→ maintenance
     │         │          │              ▲
     │         └──────────┼──────────────┘
     └────────────────────┘
```

**Epic Naming Convention**:
```
EPIC: Replace Authentication Provider
EPIC: Migrate to PostgreSQL
EPIC: Reduce API Latency
EPIC: Modernize Legacy Dashboard
```

**Recommended Labels**: `brownfield`, `change-*`, `migration`, `improvement`

**Required Task Types** (every brownfield epic should consider):
- Analysis / Discovery
- Migration plan
- Rollback plan
- Regression tests
- Monitoring updates

---

### 3.3 Grayfield Projects

**Definition**: Hybrid situation. Some systems exist, some are new.

**Characteristics**:
- Partial rewrites
- Phased replacements
- Microservices extraction
- Incremental modernization

**Epic Patterns**:
```
EPIC: Extract Auth to Microservice    (brownfield origin, greenfield target)
EPIC: Add New Billing Module          (greenfield within brownfield)
EPIC: Phase 1 Cloud Migration         (infrastructure grayfield)
```

**Recommended Labels**: `grayfield`, `extraction`, `phase-*`

---

## Part 4: Epic & Task Patterns

### 4.1 Greenfield Epic Template

```bash
# Create capability epic
ct add "EPIC: User Authentication System" --type epic --phase core \
  --labels "greenfield,capability-auth" \
  --description "Complete user authentication including registration, login, password reset, and session management."

# Create tasks under epic
ct add "Design authentication flow" --parent T001 --phase setup
ct add "Implement user registration endpoint" --parent T001 --phase core
ct add "Implement login endpoint" --parent T001 --phase core
ct add "Add password reset flow" --parent T001 --phase core
ct add "Create auth middleware" --parent T001 --phase core
ct add "Write unit tests for auth" --parent T001 --phase testing
ct add "Write integration tests" --parent T001 --phase testing
ct add "Document auth API" --parent T001 --phase polish
```

### 4.2 Brownfield Epic Template

```bash
# Create change epic
ct add "EPIC: Replace Auth0 with Custom Auth" --type epic --phase core \
  --labels "brownfield,change-auth,migration" \
  --description "Migrate from Auth0 to custom JWT authentication while maintaining backward compatibility."

# Create tasks (note the brownfield-specific tasks)
ct add "Analyze current Auth0 integration points" --parent T001 --phase setup
ct add "Document migration risks and rollback plan" --parent T001 --phase setup
ct add "Design parallel auth architecture" --parent T001 --phase core
ct add "Implement feature flag for auth switching" --parent T001 --phase core
ct add "Implement custom JWT auth" --parent T001 --phase core
ct add "Create regression test suite" --parent T001 --phase testing
ct add "Test rollback procedure" --parent T001 --phase testing
ct add "Gradual rollout to 10% users" --parent T001 --phase polish
ct add "Monitor error rates post-migration" --parent T001 --phase maintenance
ct add "Decommission Auth0 integration" --parent T001 --phase maintenance
```

### 4.3 Task Size Guidelines

| Size | Scope | Examples |
|------|-------|----------|
| `small` | < 2 hours | Fix typo, add config, update dependency |
| `medium` | 2-8 hours | Implement endpoint, create component, write tests |
| `large` | 1-3 days | Design system, implement feature, major refactor |

**Rule**: If a task feels "large", it should probably be an epic with subtasks.

---

## Part 5: Label Conventions

### 5.1 Context Labels

| Label | Meaning |
|-------|---------|
| `greenfield` | New capability creation |
| `brownfield` | Change to existing system |
| `grayfield` | Hybrid (extraction, migration) |

### 5.2 Lifecycle Labels

| Label | Meaning |
|-------|---------|
| `discovery` | Research, analysis, spike |
| `planning` | Architecture, design decisions |
| `build` | Implementation work |
| `test` | Testing and QA |
| `release` | Deployment and release prep |
| `operate` | Production operation |
| `improve` | Optimization and enhancement |

### 5.3 Epic Type Labels

| Label | Meaning |
|-------|---------|
| `capability-*` | Greenfield capability (e.g., `capability-auth`) |
| `change-*` | Brownfield change (e.g., `change-db-migration`) |
| `fix-*` | Bug fix grouping (e.g., `fix-performance`) |
| `infra-*` | Infrastructure work (e.g., `infra-ci-cd`) |

### 5.4 Risk Labels (Brownfield)

| Label | Meaning |
|-------|---------|
| `migration` | Data or system migration |
| `breaking-change` | May break existing behavior |
| `rollback-required` | Must have rollback plan |
| `feature-flag` | Behind feature flag |

---

## Part 6: Workflow Patterns

### 6.1 Greenfield Workflow

```bash
# 1. Initialize project
ct init
ct phase set setup

# 2. Create capability epics
ct add "EPIC: Core User Workflows" --type epic --phase core
ct add "EPIC: Admin Dashboard" --type epic --phase core

# 3. Work through phases
ct phase set core
ct focus set T002  # First task
# ... implement ...
ct complete T002
ct focus next

# 4. Move to testing when features complete
ct phase set testing

# 5. Polish and release
ct phase set polish

# 6. Enter maintenance loop
ct phase set maintenance
```

### 6.2 Brownfield Workflow

```bash
# 1. Initialize in existing project
ct init
ct phase set maintenance  # Start in maintenance (existing system)

# 2. Create improvement epic
ct add "EPIC: Performance Optimization" --type epic --phase core \
  --labels "brownfield,improvement"

# 3. Discovery tasks (may stay in setup phase)
ct add "Profile API endpoints" --parent T001 --phase setup
ct add "Identify top 5 slow queries" --parent T001 --phase setup

# 4. Implementation (core phase tasks)
ct add "Optimize user list query" --parent T001 --phase core
ct add "Add database indexes" --parent T001 --phase core

# 5. Validation (testing phase tasks)
ct add "Load test optimizations" --parent T001 --phase testing
ct add "Regression test existing functionality" --parent T001 --phase testing

# 6. Work on tasks across phases as needed
# (Brownfield often works multiple phases simultaneously)
```

### 6.3 Session Workflow

```bash
# Start session
ct session start

# Get suggestion (considers hierarchy, dependencies, priorities)
ct next --explain

# Focus on one task
ct focus set T042

# Work on task...

# Add progress notes
ct focus note "Completed query optimization, running tests"

# Complete and move on
ct complete T042
ct focus next

# End session
ct session end
```

---

## Part 7: CI/CD Integration

### 7.1 Phase-Based Gating

| Phase | CI/CD Stage | Gate Requirements |
|-------|-------------|-------------------|
| `setup` | - | No deployment |
| `core` | Dev/Feature | Build passes, unit tests |
| `testing` | Staging/QA | Integration tests, code review |
| `polish` | Pre-prod | Performance tests, security scan |
| `maintenance` | Production | All gates + approval |

### 7.2 Task Status and Automation

```yaml
# Example GitHub Actions integration
on:
  pull_request:
    types: [opened, synchronize]

jobs:
  validate-tasks:
    steps:
      - name: Check task status
        run: |
          # Ensure PR has associated task
          TASK_ID=$(echo "$PR_BODY" | grep -oP 'T\d+')
          ct exists $TASK_ID --quiet || exit 1

      - name: Verify phase alignment
        run: |
          TASK_PHASE=$(ct show $TASK_ID --format json | jq -r '.phase')
          CURRENT_PHASE=$(ct phase show --format json | jq -r '.current')
          # Warn if task phase doesn't match project phase
```

---

## Part 8: Best Practices

### 8.1 Epic Creation

**DO**:
- Create epics for coherent capabilities or changes
- Use clear, outcome-focused titles
- Add descriptions explaining the goal
- Apply appropriate context labels

**DON'T**:
- Create epics for single tasks
- Use vague titles like "Improvements" or "Fixes"
- Forget to set parent relationships for tasks

### 8.2 Task Discipline

**DO**:
- One task = one atomic piece of work
- Set realistic sizes
- Add dependencies when blocked
- Update status in real-time

**DON'T**:
- Create tasks you won't track
- Let tasks sit "active" for days
- Skip the testing phase tasks
- Forget brownfield risk mitigation tasks

### 8.3 Phase Discipline

**DO**:
- Set project phase intentionally
- Create tasks in appropriate phases
- Complete phase work before moving on
- Use phase for high-level progress tracking

**DON'T**:
- Ignore phase mismatches
- Stay in "core" forever
- Skip directly to maintenance
- Forget that maintenance is continuous

### 8.4 Greenfield Discipline

- Design for eventual brownfield
- Plan for users from day one
- Add monitoring before you need it
- Document as you build

### 8.5 Brownfield Discipline

- Always have a rollback plan
- Test regression before new features
- Use feature flags for risky changes
- Monitor after every change

---

## Part 9: Quick Reference

### Common Commands

```bash
# Project setup
ct init                      # Initialize project
ct phase set <slug>          # Set current phase
ct phase show                # Show current phase

# Epic management
ct add "EPIC: Title" --type epic --phase core
ct list --type epic          # List all epics

# Task management
ct add "Task title" --parent <epic-id>
ct focus set <id>            # Focus on task
ct complete <id>             # Mark done
ct next                      # Get suggestion

# Filtering
ct list --phase core         # By phase
ct list --label brownfield   # By label
ct list --status pending     # By status

# Hierarchy
ct tree                      # Visual hierarchy
ct tree <epic-id>            # Subtree
```

### Mental Model Checklist

- [ ] Is my project greenfield, brownfield, or grayfield?
- [ ] Am I in the right phase?
- [ ] Does my epic represent a coherent capability or change?
- [ ] Do my tasks have appropriate phases?
- [ ] For brownfield: Do I have risk mitigation tasks?
- [ ] Am I using labels consistently?

---

## Appendix A: Glossary

| Term | Definition |
|------|------------|
| **Greenfield** | New project with no existing constraints |
| **Brownfield** | Existing project with users, data, and constraints |
| **Grayfield** | Hybrid project (partial rewrite, migration) |
| **Phase** | Project-wide lifecycle stage |
| **Epic** | Large work item grouping related tasks |
| **Task** | Atomic work item |
| **Subtask** | Breakdown of a task |
| **Technical Debt** | Short-term decisions creating long-term cost |
| **Feature Flag** | Toggle to enable/disable features |
| **Rollback Plan** | Strategy to undo changes |

---

## Appendix B: Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0.0 | 2025-12-22 | Initial specification |

---

*This specification is part of the cleo documentation suite.*
