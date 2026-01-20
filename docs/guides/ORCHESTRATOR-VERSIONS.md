# Orchestrator Protocol Versions

**Version**: 1.0.0
**Status**: Active
**Last Updated**: 2026-01-19

---

## Version Matrix

| Document | Version | Purpose | Status |
|----------|---------|---------|--------|
| ORCHESTRATOR-PROTOCOL-SPEC.md | 1.0.0 | Formal RFC 2119 specification | AUTHORITATIVE |
| ORCHESTRATOR-PROTOCOL.md | 2.0.0 | User guide explaining v1.0 spec | CURRENT |
| ORCHESTRATOR-SPEC.md | 2.2.0 | tmux-based infrastructure (separate concern) | CURRENT |
| skills/orchestrator/SKILL.md | 1.0.0 | Skill activation for protocol | CURRENT |

---

## Relationship

```
ORCHESTRATOR-PROTOCOL-SPEC.md (v1.0.0)
    |
    +-- Implemented by: skills/orchestrator/SKILL.md
    +-- Documented by: ORCHESTRATOR-PROTOCOL.md (v2.0.0)
    +-- Infrastructure: ORCHESTRATOR-SPEC.md (v2.2.0)
```

---

## What Each Version Means

### ORCHESTRATOR-PROTOCOL-SPEC.md (v1.0.0) - THE SPECIFICATION

- Defines ORC-001 through ORC-005 constraints
- Defines manifest schema
- Defines subagent protocol
- RFC 2119 compliant (MUST/SHOULD/MAY)
- **This is the SOURCE OF TRUTH**

**Location**: `docs/specs/ORCHESTRATOR-PROTOCOL-SPEC.md`

### ORCHESTRATOR-PROTOCOL.md (v2.0.0) - THE USER GUIDE

- Explains HOW to use the protocol
- Practical examples and quick start
- References spec for details
- v2.0.0 because it includes CLI commands not in spec

**Location**: `docs/guides/ORCHESTRATOR-PROTOCOL.md`

### ORCHESTRATOR-SPEC.md (v2.2.0) - INFRASTRUCTURE

- Separate concern: tmux-based multi-agent orchestration
- Event-driven automation
- NOT required for basic orchestrator usage
- v2.2.0 reflects infrastructure maturity

**Location**: `docs/specs/ORCHESTRATOR-SPEC.md`

### skills/orchestrator/SKILL.md (v1.0.0) - SKILL ACTIVATION

- Implements ORC-001 through ORC-005 constraints
- Loads on-demand (not via CLAUDE.md)
- Subagents do NOT inherit this skill

**Location**: `skills/orchestrator/SKILL.md`

---

## Migration Notes

### From CLAUDE.md Injection (DEPRECATED)

The previous approach injected orchestrator rules directly into CLAUDE.md. This caused problems because ALL agents (including subagents) would read CLAUDE.md and attempt to orchestrate.

**Migration Steps**:

1. Remove `<!-- ORCHESTRATOR:START -->` blocks from CLAUDE.md
2. Use skill activation: `Skill: orchestrator`
3. Subagents no longer inherit orchestrator rules

### Why Skill-Based is Better

| CLAUDE.md Injection | Skill Activation |
|---------------------|------------------|
| ALL agents read it | Loads ON-DEMAND |
| Subagents also try to orchestrate | Subagents do NOT inherit skills |
| Always loaded (context overhead) | Loaded when needed |
| Breaks delegation pattern | Only HITL session operates as orchestrator |

---

## Version History

| Date | Document | Version | Change |
|------|----------|---------|--------|
| 2026-01-18 | ORCHESTRATOR-PROTOCOL-SPEC.md | 1.0.0 | Spec created |
| 2026-01-19 | ORCHESTRATOR-PROTOCOL.md | 2.0.0 | Guide updated with CLI commands |
| 2025-12-31 | ORCHESTRATOR-SPEC.md | 2.2.0 | Infrastructure spec updated |
| 2026-01-18 | skills/orchestrator/SKILL.md | 1.0.0 | Skill activation created |
| 2026-01-19 | ORCHESTRATOR-VERSIONS.md | 1.0.0 | Version guide created |

---

## Quick Reference

**Question**: Which document should I read?

| Goal | Read |
|------|------|
| Understand ORC constraints | ORCHESTRATOR-PROTOCOL-SPEC.md |
| Learn how to use orchestrator | ORCHESTRATOR-PROTOCOL.md |
| Set up tmux infrastructure | ORCHESTRATOR-SPEC.md |
| Activate orchestrator mode | skills/orchestrator/SKILL.md |

**Question**: Which is authoritative?

**Answer**: ORCHESTRATOR-PROTOCOL-SPEC.md (v1.0.0) is the source of truth for protocol behavior.
