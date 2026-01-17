# Real Schema Changes for Functional Testing

## PATCH Changes (Constraint Relaxations) - Backward Compatible

### 1. **todo.schema.json: Increase title maxLength 120→200** ✅ RECOMMENDED
**Current:** `maxLength: 120`
**Proposed:** `maxLength: 200`
**Justification:** Task titles often need more space for detailed descriptions. Current 120 char limit can be restrictive for complex features.
**Version:** 2.6.1 → 2.6.2
**Impact:** Existing data valid, allows longer titles going forward
**Migration:** 100% automated (PATCH)

### 2. **todo.schema.json: Increase description maxLength 2000→3000** ✅ RECOMMENDED
**Current:** `maxLength: 2000`
**Proposed:** `maxLength: 3000`
**Justification:** Complex implementations need detailed specifications. 2000 chars can be limiting for architecture discussions.
**Version:** 2.6.2 → 2.6.3
**Impact:** Allows more comprehensive task descriptions
**Migration:** 100% automated (PATCH)

### 3. **sessions.schema.json: Increase sessionNote maxLength 2000→3000**
**Current:** `maxLength: 2000`
**Proposed:** `maxLength: 3000`
**Justification:** Session notes track complex work sessions. More space for detailed progress tracking.
**Version:** 1.0.0 → 1.0.1
**Impact:** Richer session context
**Migration:** 100% automated (PATCH)

---

## MINOR Changes (New Optional Fields) - Backward Compatible

### 4. **todo.schema.json: Add `effort` field** ✅ RECOMMENDED
**Proposed Field:**
```json
"effort": {
  "type": "string",
  "enum": ["trivial", "small", "medium", "large", "epic"],
  "description": "Relative effort estimate (no time). Distinct from size (complexity vs effort)."
}
```
**Justification:** Aligns with "no time estimates" philosophy. `size` = complexity, `effort` = work involved. Different dimensions.
**Version:** 2.6.3 → 2.7.0
**Migration:** Auto-generated with default `null`
**Testing:** Tests ~90% MINOR automation

### 5. **todo.schema.json: Add `technicalDebt` boolean** ✅ RECOMMENDED
**Proposed Field:**
```json
"technicalDebt": {
  "type": "boolean",
  "default": false,
  "description": "Flag for tasks addressing technical debt vs new features."
}
```
**Justification:** Helps filter and prioritize debt reduction work separately from features.
**Version:** 2.7.0 → 2.7.1
**Migration:** Auto-generated with default `false`
**Testing:** Validates boolean type handling

### 6. **sessions.schema.json: Add `agentModel` field**
**Proposed Field:**
```json
"agentModel": {
  "type": "string",
  "enum": ["sonnet", "opus", "haiku", "unknown"],
  "description": "Claude model used for this session."
}
```
**Justification:** Track which model worked on which sessions for quality analysis.
**Version:** 1.0.1 → 1.1.0
**Migration:** Auto-generated with default `null`

### 7. **todo.schema.json: Add `blockerReason` field**
**Proposed Field:**
```json
"blockerReason": {
  "type": "string",
  "maxLength": 500,
  "description": "Detailed explanation of what's blocking this task. Only relevant when status=blocked."
}
```
**Justification:** Already have `blockedBy` string but need more detailed reasoning.
**Version:** 2.7.1 → 2.7.2
**Migration:** Auto-generated with default `""`

---

## MAJOR Changes (Breaking) - For Template Testing Only

### 8. **Create test schema for MAJOR testing**
**Option A:** Remove deprecated field if one exists
**Option B:** Create throwaway `test.schema.json` specifically for MAJOR testing

**Recommendation:** DON'T do real MAJOR changes to production schemas in testing. Use test schema instead.

---

## Testing Strategy - Recommended Order

### Phase 1: PATCH Testing (T1482)
1. **Change 1**: title maxLength 120→200 (todo.schema.json 2.6.1→2.6.2)
2. **Change 2**: description maxLength 2000→3000 (todo.schema.json 2.6.2→2.6.3)
3. Verify 100% automation for both

### Phase 2: MINOR Testing (T1483)  
1. **Change 3**: Add `effort` enum field (todo.schema.json 2.6.3→2.7.0)
2. **Change 4**: Add `technicalDebt` boolean (todo.schema.json 2.7.0→2.7.1)
3. **Change 5**: Add `agentModel` to sessions (sessions.schema.json 1.0.1→1.1.0)
4. Verify ~90% automation for all types

### Phase 3: MAJOR Testing (T1483)
1. Create `schemas/test-major.schema.json` with dummy field
2. Remove the dummy field
3. Verify smart template with jq hints
4. Delete test schema (don't commit)

---

## Estimated Impact

**Schema Evolution:**
- todo.schema.json: 2.6.1 → 2.7.1 (2 PATCH, 2 MINOR)
- sessions.schema.json: 1.0.0 → 1.1.0 (1 PATCH, 1 MINOR)

**Features Added:**
- Relative effort tracking (no time estimates)
- Technical debt categorization  
- Session model tracking
- Better task title/description limits

**Testing Coverage:**
- ✅ PATCH: 2 real constraint relaxations
- ✅ MINOR: 3 real optional fields (enum, boolean, string types)
- ✅ MAJOR: Test schema (non-production)

