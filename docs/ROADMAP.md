# Roadmap

> Auto-generated from CLEO task data. Current version: v0.60.1

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
See RCSD-PIPELINE-SPEC.md for the authoritative exit code list.

## Key Specs
- RCSD-PIPELINE-SPEC.md (v2.0.0 authoritative)
- LLM-AGENT-FIRST-SPEC.md (JSON output)
- CONSENSUS-FRAMEWORK-SPEC.md (consensus protocol)
- TASK-DECOMPOSITION-SPEC.md (decompose stage)

#### T1205: Unified cleo update command for project maintenance

**Phase**: core | **Progress**: 83% (5/6 tasks)

Single command to detect and fix all project-level issues when global cleo version updates. Consolidates validate --fix, migrate run, migrate repair, init --update-claude-md into one idempotent cleo update command.

#### T1243: Upgrade Command Production Readiness - Critical Bug Fixes

**Phase**: core | **Progress**: 76% (10/13 tasks)

CRITICAL: Multiple serious bugs prevent production use. See task notes for comprehensive issue documentation.

#### T1362: Cleo Work: Embedded Iterative Loop System

**Phase**: core | **Progress**: 0% (0/14 tasks)

Full 'cleo work' command system - self-contained iterative loop for working through cleo epics. No external dependencies (replaces ralph-wiggum plugin).

#### T1432: LLM-Agent-First JSON Output System with Smart Pagination

**Phase**: core | **Progress**: 0% (0/15 tasks)

Fix JSON truncation issues and implement smart pagination/sorting across all commands to comply with LLM-AGENT-FIRST-SPEC.md. Current issue: 'cleo session list' returns all 91 sessions (79KB) causing tool truncation. Solution: centralized lib/json-output.sh with pagination, smart defaults (lastActivity DESC, limit 20), and consistent compact JSON output (-c flag).

#### T1463: Automated Schema Migration System with Pre-Commit Hooks

**Phase**: core | **Progress**: 85% (6/7 tasks)

Implement automated schema migration generation to prevent manual workflow bypasses and agent confusion. Three-layer defense: (1) Remove migrate command from agent docs - agents only see 'cleo upgrade', (2) Add developer mode gate to migrate command with interactive warning/redirect, (3) Create intelligent pre-commit hook that auto-generates migration functions by analyzing schema diffs. Includes smart diff analyzer that classifies changes (PATCH/MINOR/MAJOR) and generates appropriate code - PATCH changes fully automated, MINOR/MAJOR get templates with TODOs. Replaces manual 'cleo migrate create' workflow. Prevents T1462 class of bugs where agents bypass automation.

#### T1569: Release v0.53.0 - Research Subagent Integration

**Phase**: polish | **Progress**: 0% (0/0 tasks)

Release workflow for research subcommand feature

### High Priority

#### T1523: Workflow Recipes System Integration

**Phase**: setup | **Progress**: 0% (0/15 tasks)

Research, design, and implement a comprehensive recipes system for canned workflows that enables LLM agents and users to execute complex multi-step project management workflows via single CLI commands. Integrates with CLEO position system (T805), verification gates (T1150), orchestration platform (T1062), roadmap generation (T1165), git workflow (T1114), and multi-file injection (T1384). Focus on agent-first design, security, parallel execution, and cross-epic coordination. Deliverable: claudedocs/specs/RECIPES-SYSTEM-SPEC.md for planning phase.

#### T753: Task Decomposition System Implementation (TASK-DECOMPOSITION-SPEC v1.0.0)

**Phase**: core | **Progress**: 0% (0/0 tasks)

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

**Phase**: core | **Progress**: 100% (7/7 tasks)

Implement CLEO-integrated context window monitoring and graceful shutdown protocol. Enables agents to safely stop when approaching context limits by: updating task notes, committing git changes, generating handoff documents, and ending sessions properly. Integrates with Claude Code's status line hook for real-time context awareness.

#### T1270: Cross-Project Task Import/Export System

**Phase**: core | **Progress**: 100% (6/6 tasks)

Enable selective task export from one cleo project and import into another with automatic ID remapping, hierarchy preservation, and dependency graph maintenance.

## Problem Statement
Different projects have independent ID sequences (Project A: T001-T050, Project B: T001-T025). Transferring tasks requires:
1. ID collision resolution (remap T001→T031)
2. Dependency preservation (depends:[T002] → depends:[T032])
3. Hierarchy integrity (parentId remapping)
4. Conflict detection (duplicate titles, missing refs)

## Deliverables
- cleo export-tasks command with single/subtree/filter modes
- cleo import-tasks command with ID remapping and dry-run
- .cleo-export.json package format with schema
- Conflict resolution (interactive, auto-rename, skip, fail)
- Checksum verification for integrity
- Audit trail for provenance tracking

## Key Specs
- claudedocs/IMPORT-EXPORT-SPEC.md (v1.0.0)
- claudedocs/IMPORT-EXPORT-ALGORITHMS.md
- schemas/export-package.schema.json

## Non-Goals (v1.0)
- Bidirectional sync (future feature)
- Real-time multi-project collaboration
- Archive/cancelled task export (deferred)

#### T1384: Multi-File LLM Agent Instruction Injection System

**Phase**: core | **Progress**: 90% (27/30 tasks)

Extend CLEO instruction injection to support AGENTS.md, CLAUDE.md, and GEMINI.md files. Currently injection targets only CLAUDE.md via init --update-claude-md. This epic implements multi-target injection with upgrade command integration, validation, and template management per NML compiled spec.

#### T1610: Documentation Management System

**Phase**: core | **Progress**: 10% (1/10 tasks)

Build reusable DOCUMENTOR subagent and documentation management best practices. Includes: subagent template, skill integration, versioning strategy, archiving policy, deduplication rules, temp doc handling. Designed for ANY project reuse.

#### T1342: Fix CI Test Failures (80 tests)

**Phase**: testing | **Progress**: 0% (0/7 tasks)

Fix 80 failing tests discovered after CI infrastructure repair. Tests now run but many fail.

## GitHub Issue
https://github.com/kryptobaseddev/cleo/issues/3

## Background
CI was failing immediately due to:
1. statusline-setup.sh set -e exit (fixed v0.48.4)
2. Wrong .claude/ directory in ci.yml (fixed)
3. Incorrect bats paths in test files (fixed)

Now tests run (2269+ total) but 80 fail.

## Categories (8 groups)
- LLM-Agent-First compliance: 17 tests
- Phase sync: 17 tests  
- Analyze size strategy: 11 tests
- Config system: 10 tests
- Hierarchy auto-complete: 7 tests
- TodoWrite sync: 7 tests
- Upgrade command: 6 tests
- Other (backup, error codes): 5 tests

## Last Successful CI
v0.30.1 on Dec 23, 2025

#### T1930: BATS Test Infrastructure Review

**Phase**: testing | **Progress**: 0% (0/6 tasks)

Review and fix BATS test infrastructure issues causing hangs in run-all-tests.sh and GitHub CI workflow. Tests complete individually but hang when run as a suite. Need to identify root cause (likely resource cleanup, parallel execution issues, or infinite loops) and implement fixes.

#### T998: Session System Documentation & Enhancement

**Phase**: polish | **Progress**: 35% (6/17 tasks)

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

#### T1890: CLEO System Polish & Consistency

**Phase**: polish | **Progress**: 60% (6/10 tasks)

Tactical improvements to strengthen the existing CLEO + Orchestrator system. Covers test coverage gaps, documentation drift, schema inconsistencies, and protocol standardization. Companion to T1062 (platform rewrite) - this epic focuses on immediate cleanup while T1062 handles architectural evolution. Source: docs/CLEO-SYSTEM-IMPROVEMENTS.md

#### T1941: Session System Improvements & Cleanup

**Phase**: maintenance | **Progress**: 20% (1/5 tasks)

Address session accumulation (127 sessions with no cleanup), orphaned context files (63 identified), auto-archive capability, and session binding limitations. Consolidates gaps identified during T1842/T1843 research.

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

*Generated by `cleo roadmap` on 2026-01-21*
