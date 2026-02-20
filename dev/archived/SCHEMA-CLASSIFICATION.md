# CLEO Schema Classification & Migration Requirements

## Executive Summary

**Total schemas:** 19
- **ACTIVE (in use):** 5 schemas (26%)
- **PLANNED (code ready):** 6 schemas (32%)
- **UNUSED (future):** 8 schemas (42%)

**CRITICAL ISSUES:**
- 3 ACTIVE schemas have NO migration support (archive, log, sessions)
- Pre-commit hook will FAIL if these schemas are version-bumped
- 80% of active data (3/5 schemas) unprotected from schema changes

---

## Category 1: ACTIVE (Data Files Exist)

### ✅ PROTECTED (has migrations)

| Schema | Version | Data Size | Migrations | Status |
|--------|---------|-----------|------------|--------|
| todo | 2.6.1 | 880K | 6 | ✅ Fully automated |
| config | 2.4.0 | 4.0K | 2 | ✅ Fully automated |

### 🚨 CRITICAL: UNPROTECTED (no migrations)

| Schema | Version | Data Size | Code Refs | Issue |
|--------|---------|-----------|-----------|-------|
| archive | 2.4.0 | 1.2M | 81 | Listed in hook but NO migrations |
| log | 2.4.0 | 1.7M | 72 | Listed in hook but NO migrations |
| sessions | 1.0.0 | 152K | 71 | NOT in hook, NO migrations |

**Impact:** If anyone version-bumps these schemas, pre-commit hook will FAIL.

---

## Category 2: PLANNED (Code Ready, No Data)

These schemas have validation code but no data files yet:

| Schema | Code Refs | Priority | Notes |
|--------|-----------|----------|-------|
| output | 207 | HIGH | Heavily referenced, LLM-agent-first format |
| migrations | 21 | MEDIUM | Migration tracking metadata |
| context-state | 10 | MEDIUM | Session context (coming soon) |
| export-package | 10 | LOW | Import/export feature |
| error | 5 | LOW | Error response format |
| global-config | 5 | LOW | Global user config |

**Recommendation:** Add to automation WHEN data files are created.

---

## Category 3: UNUSED (Future/Deprecated)

Zero code references, likely future RCSD system schemas:

- rcsd-consensus-report
- rcsd-index  
- rcsd-manifest
- rcsd-research-output
- rcsd-spec-frontmatter
- commands-index
- critical-path
- spec-index

**Recommendation:** Exclude from automation until actively used.

---

## Migration Automation Priority

### IMMEDIATE (fix broken state)

1. **archive** - Create base migration functions
2. **log** - Create base migration functions  
3. **sessions** - Create base migration functions + add to hook

### HIGH (when data files created)

4. **output** - 207 code refs, critical for LLM-agent workflows
5. **migrations** - Tracks migration state itself

### MEDIUM (when implemented)

6. **context-state** - Session context feature
7. **export-package** - Import/export feature

### LOW (exclude for now)

- All rcsd-* schemas (future system)
- commands-index, critical-path, spec-index (low/no usage)

---

## Recommended Pre-Commit Hook Strategy

**Option A: Auto-discover ALL schemas (SAFEST)**
```bash
# Remove hardcoded array, scan schemas/ directory
for schema in schemas/*.schema.json; do
    # Only process if has migrations OR version changed
done
```

**Option B: Explicit allowlist**
```bash
# Only schemas with migration support
schema_types=("todo" "config" "archive" "log" "sessions")
```

**Option C: Hybrid (RECOMMENDED)**
```bash
# Auto-discover, skip known-unused
skip_patterns=("rcsd-*" "spec-index" "critical-path" "commands-index")
```

---

## Action Items

1. ✅ Document schema classification (this file)
2. 🔧 Create migrations: archive, log, sessions
3. 🔧 Update pre-commit hook to auto-discover or explicit allowlist
4. 📝 Document migration policy: when to add new schemas to automation
5. 🧪 Test hook with all active schemas

