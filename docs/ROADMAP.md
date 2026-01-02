# Roadmap

> Auto-generated from CLEO task data. Current version: v0.47.0

---

## Upcoming

### Critical Priority

#### T982: RCSD Python Agent Implementation (Anthropic Agent SDK)

**Phase**: core | **Progress**: 0% (0/10 tasks)

Master epic for Python-based RCSD Pipeline implementation using Anthropic Agent SDK. Supersedes bash-script approach in T719 children. Implements 9-agent orchestration (1 Research + 5 Consensus Workers + 1 Synthesis + 1 Spec + 1 Decompose) as Python package under lib/rcsd/ callable from bash CLI wrappers.

## Architecture Overview
- Python package: lib/rcsd/
- Entry point: python -m rcsd.cli <stage> <args>
- Bash wrappers: scripts/{research,consensus,spec,decompose}.sh
- Output: LLM-AGENT-FIRST compliant JSON to stdout

## Agent → subagent_type Mapping
| RCSD Agent | subagent_type |
|------------|---------------|
| Research | deep-research-agent |
| Technical Validator | backend-architect |
| Design Philosophy | frontend-architect |
| Documentation | technical-writer |
| Implementation | refactoring-expert |
| Challenge/Red Team | requirements-analyst |
| Synthesis | project-supervisor-orchestrator |
| Spec Writer | technical-writer |
| Decompose | requirements-analyst |

## Exit Codes (30-39 reserved)
EXIT_RESEARCH_FAILED=30, EXIT_INSUFFICIENT_SOURCES=31, EXIT_CONSENSUS_FAILED=32, EXIT_HITL_REQUIRED=33, EXIT_SPEC_INVALID=34, EXIT_ATOMICITY_FAILED=35

## Key Specs
- RCSD-PIPELINE-SPEC.md (v1.0.0 authoritative)
- LLM-AGENT-FIRST-SPEC.md (JSON output)
- CONSENSUS-FRAMEWORK-SPEC.md (consensus protocol)
- TASK-DECOMPOSITION-SPEC.md (decompose stage)

#### T1205: Unified cleo update command for project maintenance

**Phase**: core | **Progress**: 100% (4/4 tasks)

Single command to detect and fix all project-level issues when global cleo version updates. Consolidates validate --fix, migrate run, migrate repair, init --update-claude-md into one idempotent cleo update command.

### High Priority

#### T753: Task Decomposition System Implementation (TASK-DECOMPOSITION-SPEC v1.0.0)

**Phase**: core | **Progress**: 100% (1/1 tasks)

Master Epic for implementing the Task Decomposition System per TASK-DECOMPOSITION-SPEC.md v1.0.0. This implements Stage 4 (DECOMPOSE) of the RCSD Pipeline.

## CRITICAL SUBAGENT REQUIREMENTS

**ALL subagents working on Phase tasks and subtasks MUST:**
1. Update task notes regularly with progress details
2. Document what was completed in each work session
3. Record any issues, blockers, or unexpected findings
4. Note any deviations from the spec with rationale
5. Update notes BEFORE ending session for handoff

**Note Update Pattern:**
```bash
ct update <task-id> --notes "Session <date>: <what was done>"
ct update <task-id> --notes "BLOCKER: <issue description>"
ct update <task-id> --notes "COMPLETE: <summary of deliverables>"
```

## Implementation Phases

1. **Phase 1: Core Infrastructure** - Create lib/decomposition.sh, lib/llm-invoke.sh, scripts/decompose.sh
2. **Phase 2: Decomposition Pipeline** - Implement analyze_scope(), decompose_goals(), build_dependency_graph(), specify_tasks()
3. **Phase 3: Challenge System** - Challenge agent integration per CONSENSUS-FRAMEWORK-SPEC
4. **Phase 4: Dependency Detection** - Explicit, data flow, file conflict, semantic detection
5. **Phase 5: HITL Integration** - Human-in-the-loop gates and AskUserQuestion integration
6. **Phase 6: Schema Extensions** - Add decompositionId, atomicityScore, acceptance fields
7. **Phase 7: Testing** - Unit, integration, challenge, performance tests
8. **Phase 8: Documentation** - QUICK-REFERENCE, TODO_Task_Management, user guide

## Dependencies
- Requires: HIERARCHY-ENHANCEMENT-SPEC (type, parentId, size)
- Requires: LLM-AGENT-FIRST-SPEC (JSON output, exit codes)
- Requires: CONSENSUS-FRAMEWORK-SPEC (challenge protocol)
- Requires: LLM-TASK-ID-SYSTEM-DESIGN-SPEC (task ID format)

## Key Specifications
- Spec: docs/specs/TASK-DECOMPOSITION-SPEC.md
- Report: docs/specs/TASK-DECOMPOSITION-SPEC-IMPLEMENTATION-REPORT.md
- Target: v0.22.0+

#### T805: Explicit Positional Ordering System

**Phase**: core | **Progress**: 0% (0/6 tasks)

Enable explicit, ID-independent task ordering where position/rank is separate from task ID. Epics, tasks, and subtasks each have shuffleable positions. LLM agents see FORCED priority order with dependency/blocking info. Currently: only categorical priority + creation date ordering exists. Need: position field, reorder commands, mandatory position assignment, dependency-aware display. Requires research on scope (per-parent vs global), enforcement strategy, and integration with existing priority field.

#### T1062: Epic: CLEO Orchestration Platform - Deterministic State Machine for LLM Agent Workflows

**Phase**: core | **Progress**: 0% (0/13 tasks)

Transform CLEO from a task management CLI into a full CI/CD-like orchestration platform for LLM agent workflows. Implements deterministic Python-based routing (not LLM interpretation), verification gates for subagent coordination via DuckDB state, and templated prompts per agent role. Covers all 5 pipeline layers: Ingestion (60-69), RCSD (30-39), Implementation (40-49), Release (50-59), and Maintenance. Key principles: No API keys, deterministic routing, state in database, templated prompts, verification gates, session isolation, async where possible, hybrid polling/events. See claudedocs/CLEO-ORCHESTRATION-PLATFORM-PROPOSAL.md for full proposal.

#### T1074: CLEO Claude Code Plugin Implementation

**Phase**: core | **Progress**: 35% (7/20 tasks)

Implement companion Claude Code plugin for CLEO (Option A architecture). Plugin provides Claude-native integration while preserving standalone CLI. Replaces CLAUDE.md injection with auto-discovered skills, adds slash commands, agents, and session lifecycle hooks. See claudedocs/specs/CLEO-PLUGIN-SPEC.md for full specification.

#### T1165: Automated Roadmap Generation System

**Phase**: core | **Progress**: 40% (2/5 tasks)

Implement ct roadmap command to generate ROADMAP.md from CLEO task data. Phase 1: Generate from pending epics and CHANGELOG. Phase 2: Full release management per RELEASE-MANAGEMENT-SPEC.md. Enables data-driven roadmap that stays synchronized with actual work.

#### T1185: NEXUS Agent Protocol Specification

**Phase**: core | **Progress**: 0% (0/9 tasks)

Define the NEXUS Agent Protocol - a specification for HOW LLM agents behave and communicate. NEXUS is the agent behavior layer, while CLEO handles WHERE agents run (tmux orchestration). Separation of concerns: NEXUS = agent protocol/behavior, CLEO = infrastructure/state management. This epic covers: agent communication patterns, event-based handoffs, schema ownership model, verification gate protocols, and integration with CLEO's tmux orchestration.

#### T1198: Context Safeguard System (Agent Graceful Shutdown)

**Phase**: core | **Progress**: 100% (6/6 tasks)

Implement CLEO-integrated context window monitoring and graceful shutdown protocol. Enables agents to safely stop when approaching context limits by: updating task notes, committing git changes, generating handoff documents, and ending sessions properly. Integrates with Claude Code's status line hook for real-time context awareness.

#### T998: Session System Documentation & Enhancement

**Phase**: polish | **Progress**: 60% (17/28 tasks)

EPIC: Session System Documentation & Enhancement

**RCSD Phases:**

## Phase 1: Research & Design (setup)
- T1013: Design seamless multi-agent session binding [CRITICAL BLOCKER]

## Phase 2: Core Fixes (core) 
Fix bugs blocking proper multi-session usage:
- T1012: Auto-set currentSessionId in sessions.json
- T1008: Fix session status to read from sessions.json
- T1011: Default multiSession.enabled=true in templates
- T1010: Clean up stale migrated legacy sessions

## Phase 3: Validation & UX (core)
- T1003: Improve session start UX when multiSession disabled
- T1004: Validate agent ID uniqueness
- T1005: Validate scope type enum

## Phase 4: Documentation (polish)
- T999: Rewrite docs/commands/session.md
- T1000: Document scope types and conflict detection
- T1001: Document sessions.json file structure
- T1002: Document multi-session configuration
- T1007: Update TODO_Task_Management.md
- T1009: Document CLEO_SESSION requirement

## Phase 5: Enhancements (polish)
- T1006: Auto-generate session names from scope

**Execution Model:**
- Each phase = 1 scoped session
- Tasks within phase can be parallelized by multiple agents
- Phase N+1 blocked until Phase N complete

### Medium Priority

#### T653: Multi-Agent Sync Protocol Adapters

**Phase**: core | **Progress**: 0% (0/0 tasks)

Agent-agnostic sync adapter framework enabling cleo to work with multiple AI coding agents (Claude Code, Gemini CLI, Codex CLI, Kimi CLI, etc.).

**Architecture** (Implementation-Agnostic):
- Adapter interface: inject(), extract(), status_map(), status_unmap()
- Agent detection via env vars and heuristics
- Generic fallback adapter for unknown agents
- ID embedding pattern: [T###] prefix

**Reference Docs**:
- docs/specs/MULTI-AGENT-ABSTRACTION-SPEC.md (authoritative)
- claudedocs/CLEO-Rebrand/research/MULTI-AGENT-ABSTRACTION-PLAN.md

**Deferred From**: T650 (CLEO Rebrand v1.0.0)
**Target**: v2.0.0+ or post-Python migration

**Note**: Design principles are language-agnostic. Implementation will align with future tech stack (Python/DuckDB).

#### T1171: Visual Showcase & Marketing Assets

**Phase**: polish | **Progress**: 0% (0/9 tasks)

Create compelling visual demonstrations of CLEO for Reddit posts and README. Goal: Show what CLEO does in screenshots that hook viewers in 2 seconds. Includes terminal screenshots, side-by-side comparisons, animated GIFs, and demo project creation.

### Low Priority

#### T1231: BACKLOG: Deferred Features & Future Enhancements

**Phase**: maintenance | **Progress**: 0% (0/3 tasks)

Parking lot for validated but deferred features. Tasks here are NOT abandoned - they're waiting for the right time or evidence of need. Review quarterly.

---

## Release History

| Version | Date |
|---------|------|
| v0.47.0 | 2026-01-02 |
| v0.46.0 | 2026-01-02 |
| v0.45.0 | 2026-01-02 |
| v0.44.0 | 2026-01-02 |
| v0.43.2 | 2026-01-02 |
| v0.43.1 | 2026-01-02 |
| v0.43.0 | 2026-01-01 |
| v0.42.2 | 2025-12-31 |
| v0.42.1 | 2025-12-31 |
| v0.42.0 | 2025-12-31 |
| v0.41.10 | 2025-12-31 |
| v0.41.9 | 2025-12-31 |
| v0.41.8 | 2025-12-30 |
| v0.41.7 | 2025-12-29 |
| v0.41.6 | 2025-12-29 |

---

*Generated by `cleo roadmap` on 2026-01-02*
