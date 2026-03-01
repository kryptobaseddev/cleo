# RCSD Pipeline Directory

This directory contains all Research-Consensus-Spec-Decompose (RCSD) pipeline artifacts.

## Directory Structure

```
.claude/rcsd/
├── RCSD-INDEX.json              # Master index (AUTHORITATIVE)
├── README.md                    # This file
│
└── TXXX_[short-name]/           # Task-anchored directories
    ├── _manifest.json           # Pipeline state and file references
    │
    ├── TXXX_[short-name]_research.json      # Research output (JSON)
    ├── TXXX_[short-name]_research.md        # Research output (human-readable)
    │
    ├── TXXX_[short-name]_consensus-report.json   # Consensus validation (JSON)
    ├── TXXX_[short-name]_CONSENSUS-REPORT.md     # Consensus report (human-readable)
    │
    ├── TXXX_[short-name]_agent-*-findings.md     # Agent findings (per agent)
    ├── TXXX_[short-name]_synthesis-voting-matrix.md  # Voting matrix
    │
    ├── [SHORT-NAME]-SPEC.md                 # Final specification
    └── [SHORT-NAME]-IMPLEMENTATION-REPORT.md # Implementation tracking
```

## File Naming Conventions

| Pattern | Example | Purpose |
|---------|---------|---------|
| `TXXX_[short-name]/` | `T500_auth-patterns/` | Task-anchored directory |
| `TXXX_[short-name]_research.json` | `T500_auth-patterns_research.json` | Research output |
| `TXXX_[short-name]_consensus-report.json` | `T500_auth-patterns_consensus-report.json` | Consensus report |
| `[SHORT-NAME]-SPEC.md` | `AUTH-PATTERNS-SPEC.md` | Specification document |
| `[SHORT-NAME]-IMPLEMENTATION-REPORT.md` | `AUTH-PATTERNS-IMPLEMENTATION-REPORT.md` | Implementation report |

## Short-Name Derivation

Short names are derived from task titles:
1. Strip task ID prefix (`T###:`)
2. Remove version patterns (`v1.0.0`)
3. Convert to lowercase
4. Split on non-alphanumeric characters
5. Filter stop words (the, a, an, for, to, with, of, and, in, on, is, be)
6. Take 2-3 meaningful words
7. Join with hyphens
8. Truncate to max 25 characters

Examples:
- `T500: Authentication Best Practices` → `auth-best-practices`
- `T501: OAuth 2.1 Implementation Guide` → `oauth-impl-guide`
- `T502: CLI Design Patterns for LLM Agents` → `cli-design-patterns`

## Pipeline Stages

```
RESEARCH → CONSENSUS → SPEC → DECOMPOSE
    ↓         ↓         ↓         ↓
research.json  consensus-report.json  *-SPEC.md  Tasks created
```

## Schema References

All files validate against schemas in `/schemas/`:
- `rcsd-index.schema.json` - RCSD-INDEX.json
- `rcsd-manifest.schema.json` - _manifest.json
- `rcsd-research-output.schema.json` - *_research.json
- `rcsd-consensus-report.schema.json` - *_consensus-report.json
- `rcsd-spec-frontmatter.schema.json` - *-SPEC.md frontmatter

## Related Documentation

- [RCSD-PIPELINE-SPEC.md](/docs/specs/RCSD-PIPELINE-SPEC.md) - Authoritative specification
- [RCSD-PIPELINE-IMPLEMENTATION-REPORT.md](/docs/specs/RCSD-PIPELINE-IMPLEMENTATION-REPORT.md) - Implementation progress
