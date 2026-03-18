# T5716 Master Plan: @cleocode/core Standalone Completion

**Date**: 2026-03-18
**Epic**: T5716
**Branch**: feature/T5701-core-extraction
**PR**: #59

---

## 1. SITUATION ASSESSMENT

### Recon A: Core Package Audit
**PRODUCTION-READY with minor gaps.**
- packages/core/src/cleo.ts — 546 lines, 7 domain APIs all wired and verified
- packages/core/dist/index.js — 1.3MB esbuild bundle, zero back-refs, SQLite bundled inline
- E2E smoke test: 10/10 assertions pass
- All 3 consumer patterns verified (Facade, Tree-shaking, Custom store)
- **Gap**: No README.md in packages/core/

### Recon B: TODO/FIXME/HACK Scan
**ZERO VIOLATIONS.** No action needed.

### Recon C: Canon Documentation Audit
**5+ docs need updates:**
- CRITICAL: AGENTS.md — architecture section (lines 92-143) never mentions @cleocode/core
- HIGH: CLEO-OPERATION-CONSTITUTION.md — needs package separation section
- MEDIUM: CLEO-VISION.md, CLEO-SYSTEM-FLOW-ATLAS.md, NEXUS-CORE-ASPECTS.md
- LOW: CLEO-CANON-INDEX.md, CORE-PACKAGE-SPEC.md status promotion

### Recon D: Unused Imports Scan
**EXCELLENT discipline. One item:**
- src/core/skills/orchestrator/validator.ts:24 — commented-out `validateReturnMessage` import needs resolving

---

## 2. PHASED EXECUTION PLAN

### Phase 1: Core Package Polish & README (1 task)
Create packages/core/README.md, promote CORE-PACKAGE-SPEC, resolve one dead import.

### Phase 2: Import Rewiring (3 tasks)
Rewire 229 imports across dispatch (156), CLI (61), MCP (12) from relative src/core/ to @cleocode/core.
**Key risk**: esbuild plugin must resolve @cleocode/core to workspace source during build.
**Strategy**: Rewire one engine file first as proof-of-concept, verify build+tests, then batch.

### Phase 3: Canon Documentation Update (2 tasks)
Update AGENTS.md, CLEO-OPERATION-CONSTITUTION.md, and 4 other canon docs.
**Can run parallel with Phase 2** (different file sets).

### Phase 4: Validation & PR Finalization (1 task)
Full test suite, purity gate, smoke tests, PR #59 update.

---

## 3. TASK REGISTRY

### Phase 1: Core Package Polish

| ID | Title | Deps | Scope | Key Files |
|----|-------|------|-------|-----------|
| P1-01 | Create packages/core/README.md + promote CORE-PACKAGE-SPEC + resolve dead import | None | Small | packages/core/README.md, docs/specs/CORE-PACKAGE-SPEC.md, src/core/skills/orchestrator/validator.ts |

### Phase 2: Import Rewiring

| ID | Title | Deps | Scope | Key Files |
|----|-------|------|-------|-----------|
| P2-01 | Rewire dispatch engine imports (156 imports) + update esbuild plugin | P1-01 | Large | src/dispatch/engines/*.ts, build.mjs, package.json |
| P2-02 | Rewire CLI command imports (61 imports) | P2-01 | Medium | src/cli/commands/*.ts, src/cli/index.ts |
| P2-03 | Rewire MCP + remaining imports (12 imports) | P2-02 | Small | src/mcp/*.ts, src/dispatch/domains/*.ts |

### Phase 3: Canon Documentation Update

| ID | Title | Deps | Scope | Key Files |
|----|-------|------|-------|-----------|
| P3-01 | Update AGENTS.md architecture + CLEO-OPERATION-CONSTITUTION.md | None | Medium | AGENTS.md, docs/specs/CLEO-OPERATION-CONSTITUTION.md |
| P3-02 | Update remaining canon docs + canon index | P3-01 | Small | CLEO-VISION.md, CLEO-SYSTEM-FLOW-ATLAS.md, NEXUS-CORE-ASPECTS.md, CLEO-CANON-INDEX.md |

### Phase 4: Validation

| ID | Title | Deps | Scope | Key Files |
|----|-------|------|-------|-----------|
| P4-01 | Full validation, purity gate, PR #59 update | P2-03, P3-02 | Medium | tests, dev/check-core-purity.sh, PR description |

---

## 4. AGENT DEPLOYMENT STRATEGY

| Phase | Agents | Parallel? | Budget |
|-------|--------|-----------|--------|
| P1 | 1 | Standalone | ~50K |
| P2 | 1 per task, sequential | No | ~150K each |
| P3 | 1-2, parallel with P2 | Yes | ~80K each |
| P4 | 1 | After all | ~100K |

**Execution order:**
1. P1-01 (small, sets the stage)
2. P2-01 + P3-01 in parallel
3. P2-02 after P2-01
4. P2-03 + P3-02 in parallel
5. P4-01 after everything

---

## 5. RISK REGISTER

| Risk | Prob | Impact | Mitigation |
|------|------|--------|------------|
| Import rewiring breaks build | Medium | High | Rewire one file first, verify, then batch |
| esbuild treats @cleocode/core as external | Medium | High | Update build.mjs plugin to resolve to workspace source |
| Store layer not fully exported from core | Medium | Medium | Keep store as direct relative imports (implementation detail of @cleocode/cleo) |
| Type resolution breaks | Medium | Medium | Add tsconfig path mapping if needed |
| Test suite regression | Low | Medium | Run tests after each phase |

**Critical decision**: Store imports (src/store/) stay as direct relative imports in dispatch/CLI/MCP — they are @cleocode/cleo internals, not @cleocode/core public API. Only DataAccessor interface is exported from core.
