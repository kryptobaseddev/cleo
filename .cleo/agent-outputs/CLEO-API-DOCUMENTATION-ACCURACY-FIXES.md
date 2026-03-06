# CLEO API Documentation Accuracy Fixes

**Date**: 2026-03-06  
**Status**: ✅ Complete  

---

## Issues Fixed

### 1. Missing `sticky` Domain

**Problem**: CLEO-API.md listed only 9 domains, missing `sticky`

**Solution**: Added `sticky` domain with correct counts:
- sticky: 2 query + 4 mutate = 6 total

**Files Updated:**
- `docs/specs/CLEO-API.md` - Added sticky to domain table
- `docs/specs/CLEO-NEXUS-API-CAPABILITIES.md` - Added sticky to API surface table

### 2. Incorrect Operation Counts

**Problem**: Operation counts in documentation didn't match CLEO-OPERATION-CONSTITUTION.md

**Before (Wrong):**
```
tasks: 26 (13q/13m)
session: 17 (10q/7m)
pipeline: 17 (5q/12m)
orchestrate: 16 (10q/6m)
tools: 27 (16q/11m)
admin: 26+ (14+q/12m)
check: 12 (10q/2m)
nexus: 24 (13q/11m)
Total: 183+ ops (103+q/80m)
```

**After (Correct per Constitution):**
```
tasks: 32 (17q/15m)
session: 19 (11q/8m)
pipeline: 37 (14q/23m)
orchestrate: 19 (11q/8m)
tools: 32 (21q/11m)
admin: 43 (23q/20m)
check: 19 (17q/2m)
nexus: 31 (17q/14m)
sticky: 6 (2q/4m)
Total: 256 ops (145q/111m)
```

**Files Updated:**
- `docs/specs/CLEO-API.md` - Fixed all domain counts
- `docs/specs/CLEO-NEXUS-API-CAPABILITIES.md` - Fixed API surface table

### 3. Missing Context on 256 Operations

**Problem**: Didn't explain why there are 256 operations

**Solution**: Added comprehensive explanation to CLEO-API.md:

**Why 256 Operations?**
- **System Coverage**: BRAIN (18) + LOOM (37) + NEXUS (31) + LAFS (protocol layer)
- **Granularity**: CRUD per domain, CQRS split (query/mutate), sub-namespaces
- **Progressive Disclosure**: Tier 0 (~149), Tier 1 (~51), Tier 2 (~56)
- **Comparison**: GitHub (~600+), Linear (~100+), Jira (~1,000+)

**Document**: `docs/specs/CLEO-API.md` Section 4.1

---

## Verification Against Source of Truth

All counts now match `docs/specs/CLEO-OPERATION-CONSTITUTION.md`:

| Domain | Query | Mutate | Total | Source |
|--------|-------|--------|-------|--------|
| tasks | 17 | 15 | 32 | Constitution §6.1 |
| session | 11 | 8 | 19 | Constitution §6.2 |
| memory | 12 | 6 | 18 | Constitution §6.3 |
| check | 17 | 2 | 19 | Constitution §6.4 |
| pipeline | 14 | 23 | 37 | Constitution §6.5 |
| orchestrate | 11 | 8 | 19 | Constitution §6.6 |
| tools | 21 | 11 | 32 | Constitution §6.7 |
| admin | 23 | 20 | 43 | Constitution §6.8 |
| nexus | 17 | 14 | 31 | Constitution §6.9 |
| sticky | 2 | 4 | 6 | Constitution §6.10 |
| **Total** | **145** | **111** | **256** | Constitution Summary |

---

## 10 Canonical Domains (Complete)

Per `src/dispatch/types.ts` and CLEO-VISION.md:

1. **tasks** - Task hierarchy, CRUD, dependencies
2. **session** - Session lifecycle, decisions, context
3. **memory** - BRAIN cognitive memory (observations, patterns, learnings)
4. **check** - Validation, protocol compliance, testing
5. **pipeline** - RCASD-IVTR+C lifecycle, releases
6. **orchestrate** - Multi-agent coordination, wave planning
7. **tools** - Skills, providers, issues, CAAMP catalog
8. **admin** - Configuration, backup, migration, diagnostics
9. **nexus** - Cross-project coordination, registry, sharing
10. **sticky** - Ephemeral capture, quick notes

---

## Document Hierarchy (Corrected)

```
CLEO-API.md (Master)
├── CLEO-NEXUS-API.md (Cross-project layer)
├── CLEO-WEB-API.md (HTTP/Fastify spec)
└── CLEO-NEXUS-API-CAPABILITIES.md (Use cases)

Sources of Truth:
├── CLEO-OPERATION-CONSTITUTION.md (256 operations)
├── CLEO-VISION.md (10 domains, 4 systems)
└── VERB-STANDARDS.md (canonical verbs)
```

---

## Remaining Items

### High Priority (Separate Tasks)

1. **Build Fastify HTTP Server** (EPIC T5430)
   - Status: Not started
   - Location: src/web/server/ (doesn't exist yet)
   - Requirements: Fastify 5.8.x, @fastify/sensible, @fastify/type-provider-typebox

2. **Purge projects-registry.json**
   - Status: Still referenced in 48 locations
   - Files to update: src/core/nexus/registry.ts, migration code, tests
   - Action: Complete removal from codebase

### Documentation (Future)

- CLEO-SDK-GUIDE.md - Not yet created
- CLEO-ARCHITECTURE.md - May need updates

---

## Accuracy Checklist

✅ 10 canonical domains listed correctly  
✅ 256 total operations (145q/111m)  
✅ All domain counts match Constitution  
✅ Sticky domain included  
✅ Document hierarchy established  
✅ No legacy redirects (clean break)  
✅ CLEO-MCP-API removed from references  
✅ Implementation Epic T5430 documented  

---

**Status**: ✅ All documentation now accurate and aligned  
**Next**: Implement Fastify server (T5430) and purge legacy code
