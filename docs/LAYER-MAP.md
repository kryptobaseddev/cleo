# CLEO Library Layer Map

**Version**: 0.33.0
**Last Updated**: 2025-12-24
**Status**: AUTHORITATIVE

This document is the definitive reference for library layer assignments.

---

## Layer Overview

| Layer | Purpose | Max Deps | Count |
|-------|---------|----------|-------|
| **Layer 0** | Foundation - constants, platform detection | 0 | 3 |
| **Layer 1** | Core Infrastructure - utilities, file ops | 2 | 9 |
| **Layer 2** | Core Services - validation, backup, migration | 3 | 4 |
| **Layer 3** | Domain Logic - business operations | 3 | 7 |

---

## Layer 0: Foundation (No Dependencies)

| Library | Purpose | Dependencies |
|---------|---------|--------------|
| `exit-codes.sh` | Exit code constants | None |
| `platform-compat.sh` | Platform detection, command aliases | None |
| `version.sh` | Version string | None |

---

## Layer 1: Core Infrastructure

| Library | Purpose | Dependencies |
|---------|---------|--------------|
| `atomic-write.sh` | Primitive atomic file operations | exit-codes, platform-compat |
| `config.sh` | Configuration management | exit-codes, platform-compat |
| `dependency-check.sh` | Dependency verification | platform-compat |
| `error-json.sh` | Structured error output | exit-codes, platform-compat |
| `file-ops.sh` | High-level file operations | platform-compat, config, atomic-write |
| `hierarchy.sh` | Task hierarchy validation | exit-codes, config |
| `jq-helpers.sh` | jq utility functions | None |
| `logging.sh` | Audit logging | platform-compat, atomic-write |
| `output-format.sh` | Format detection/resolution | None |

---

## Layer 2: Core Services

| Library | Purpose | Dependencies |
|---------|---------|--------------|
| `backup.sh` | Backup operations | file-ops, logging |
| `cache.sh` | Cache management | platform-compat |
| `migrate.sh` | Schema migrations | atomic-write, logging |
| `validation.sh` | Schema/semantic validation | platform-compat, exit-codes, config |

*Note: validation.sh lazy-loads migrate.sh and hierarchy.sh when needed.*

---

## Layer 3: Domain Logic

| Library | Purpose | Dependencies |
|---------|---------|--------------|
| `analysis.sh` | Task analysis algorithms | file-ops, validation |
| `archive-cancel.sh` | Archive cancellation | exit-codes, config, file-ops |
| `cancel-ops.sh` | Cancellation operations | exit-codes, validation, backup |
| `delete-preview.sh` | Deletion preview | exit-codes, hierarchy |
| `deletion-strategy.sh` | Deletion logic | exit-codes, hierarchy, file-ops |
| `phase-tracking.sh` | Phase management | platform-compat, file-ops |
| `todowrite-integration.sh` | TodoWrite sync | None |

---

## Dependency Flow

```
L3 (Domain) ──┬──► L2 (Services) ──┬──► L1 (Infrastructure) ──┬──► L0 (Foundation)
              │                    │                          │
              ▼                    ▼                          ▼
         analysis.sh          backup.sh                 file-ops.sh      exit-codes.sh
         cancel-ops.sh        migrate.sh                logging.sh       platform-compat.sh
         deletion-strategy.sh validation.sh             config.sh        version.sh
```

---

## Rules

1. **Dependencies flow downward only** (L3 → L2 → L1 → L0)
2. **No same-layer dependencies** at load time
3. **Lazy loading** permitted for optional same-layer deps
4. **Maximum dependencies**: L0=0, L1=2, L2=3, L3=3

---

*Last validated: 2025-12-24*
