# Refactor Epic Example: Modernize Authentication System

This example demonstrates a brownfield refactoring epic for modernizing legacy code with safety checkpoints and rollback capability.

---

## Scenario

An existing Express.js application needs to modernize its authentication system:
- Replace session-based auth with JWT tokens
- Update password hashing from MD5 to bcrypt
- Add refresh token support
- Maintain backwards compatibility during transition
- Enable rollback at each phase

**Risk Level**: Medium-High (existing users, production data)

**Classification**: Brownfield refactor (existing codebase)

---

## Step 1: Impact Analysis (Wave 0 - Always First for Brownfield)

Before creating the epic, perform impact analysis:

```bash
# Check for related existing work
{{TASK_FIND_CMD}} "auth" --status pending
{{TASK_LIST_CMD}} --type epic | jq '.tasks[] | select(.title | test("auth"; "i"))'

# Verify current project phase
{{TASK_PHASE_CMD}}
```

---

## Step 2: Create the Refactor Epic

```bash
{{TASK_ADD_CMD}} "EPIC: Modernize Authentication System" \
  --type epic \
  --size large \
  --priority high \
  --phase core \
  --epic-lifecycle planning \
  --labels "refactor,auth,security,brownfield,v2.0" \
  --description "Modernize legacy auth from session-based to JWT. Phases: (1) Impact analysis, (2) New auth module parallel to legacy, (3) Gradual migration with feature flags, (4) Legacy removal. Each phase has rollback checkpoint." \
  --acceptance "All auth flows use JWT" \
  --acceptance "Password hashing upgraded to bcrypt" \
  --acceptance "Refresh tokens implemented" \
  --acceptance "Rollback tested at each phase" \
  --acceptance "Zero user disruption" \
  --notes "Refactor plan approved by security team. Requires coordinated deployment."
```

**Annotation**: Refactor epics use `--epic-lifecycle planning` initially. Labels include `brownfield` and `refactor` for filtering. Acceptance criteria emphasize safety (rollback, zero disruption).

---

## Step 3: Create Tasks by Phase

### Wave 0: Impact Analysis (Foundation - No Dependencies)

```bash
# T1: Impact analysis and discovery (Wave 0)
{{TASK_ADD_CMD}} "Analyze current auth system and dependencies" \
  --type task \
  --size medium \
  --priority critical \
  --parent {{EPIC_ID}} \
  --phase setup \
  --labels "refactor,analysis,wave-0" \
  --description "Document current auth implementation. Map all files, functions, and integration points. Identify external dependencies (third-party services, APIs). Create dependency graph." \
  --acceptance "Auth dependency map documented" \
  --acceptance "All integration points identified" \
  --acceptance "External service dependencies listed" \
  --acceptance "Files to modify cataloged" \
  --files "docs/refactor/auth-impact-analysis.md"

# T2: Create regression test baseline (Wave 0 - parallel with T1)
{{TASK_ADD_CMD}} "Create regression test baseline for auth" \
  --type task \
  --size medium \
  --priority high \
  --parent {{EPIC_ID}} \
  --phase setup \
  --labels "refactor,testing,wave-0,regression" \
  --description "Write integration tests for ALL current auth behaviors BEFORE any changes. These tests verify no regressions during refactor." \
  --acceptance "Login flow tested (success and failure)" \
  --acceptance "Session handling tested" \
  --acceptance "Password validation tested" \
  --acceptance "All edge cases covered" \
  --files "tests/auth/regression-baseline.test.ts"
```

**Annotation**: Wave 0 for refactors MUST include impact analysis AND regression baseline. Never modify code without tests first.

### Wave 1: New Module Creation (Depends on Wave 0)

```bash
# T3: Create new JWT auth module (Wave 1 - depends on T1, T2)
{{TASK_ADD_CMD}} "Create new JWT auth module (parallel to legacy)" \
  --type task \
  --size large \
  --priority high \
  --parent {{EPIC_ID}} \
  --phase core \
  --depends {{T1_ID}},{{T2_ID}} \
  --labels "refactor,jwt,implementation,wave-1" \
  --description "Create NEW auth module using JWT. Do NOT modify legacy code yet. New module runs parallel to existing auth. Feature flag controls which system is used." \
  --acceptance "JWT generation and validation working" \
  --acceptance "Refresh token rotation implemented" \
  --acceptance "Module isolated from legacy code" \
  --acceptance "Feature flag controls activation" \
  --files "src/lib/auth-v2/jwt.ts,src/lib/auth-v2/tokens.ts,src/lib/auth-v2/index.ts"

# T4: Implement bcrypt password hashing (Wave 1 - parallel with T3)
{{TASK_ADD_CMD}} "Implement bcrypt password hashing utilities" \
  --type task \
  --size small \
  --priority high \
  --parent {{EPIC_ID}} \
  --phase core \
  --depends {{T1_ID}},{{T2_ID}} \
  --labels "refactor,bcrypt,security,wave-1" \
  --description "Create bcrypt hashing utilities. Include migration function that can verify both MD5 (legacy) and bcrypt (new) hashes for gradual transition." \
  --acceptance "Bcrypt hash function works" \
  --acceptance "Dual-hash verification supports migration" \
  --acceptance "Timing-safe comparison used" \
  --files "src/lib/auth-v2/password.ts"

# T5: Create rollback procedure for Wave 1 (Wave 1 - parallel)
{{TASK_ADD_CMD}} "Create Wave 1 rollback procedure" \
  --type task \
  --size small \
  --priority high \
  --parent {{EPIC_ID}} \
  --phase core \
  --depends {{T1_ID}} \
  --labels "refactor,rollback,wave-1" \
  --description "Document and test rollback: disable feature flag, verify legacy auth still works. Test procedure in staging." \
  --acceptance "Rollback procedure documented" \
  --acceptance "Tested in staging environment" \
  --acceptance "Recovery time under 5 minutes" \
  --files "docs/refactor/wave-1-rollback.md"
```

**Annotation**: T3, T4, T5 all depend on Wave 0 completion but are independent of each other (PARALLEL). New code is ADDITIVE - no legacy modifications yet.

### Wave 2: Integration Layer (Depends on T3, T4)

```bash
# T6: Create auth adapter/facade (Wave 2 - convergence point)
{{TASK_ADD_CMD}} "Create auth adapter for gradual migration" \
  --type task \
  --size medium \
  --priority high \
  --parent {{EPIC_ID}} \
  --phase core \
  --depends {{T3_ID}},{{T4_ID}} \
  --labels "refactor,adapter,wave-2" \
  --description "Create adapter layer that can route to either legacy or new auth based on feature flag. Handles dual-hash password verification during migration." \
  --acceptance "Adapter routes correctly by feature flag" \
  --acceptance "Dual-hash verification works" \
  --acceptance "Metrics track which system handles requests" \
  --files "src/lib/auth/adapter.ts"

# T7: Integration tests for new auth (Wave 2 - parallel with T6)
{{TASK_ADD_CMD}} "Write integration tests for new auth module" \
  --type task \
  --size medium \
  --priority high \
  --parent {{EPIC_ID}} \
  --phase testing \
  --depends {{T3_ID}},{{T4_ID}},{{T5_ID}} \
  --labels "refactor,testing,wave-2" \
  --description "Write comprehensive tests for new JWT auth. Verify behavior matches legacy system. Test rollback procedure." \
  --acceptance "JWT flow tests pass" \
  --acceptance "Refresh token tests pass" \
  --acceptance "Rollback procedure verified" \
  --files "tests/auth/jwt-auth.test.ts"
```

### Wave 3: Gradual Migration (Depends on T6, T7)

```bash
# T8: Enable new auth for new users (Wave 3)
{{TASK_ADD_CMD}} "Enable new auth for new user registrations" \
  --type task \
  --size small \
  --priority medium \
  --parent {{EPIC_ID}} \
  --phase core \
  --depends {{T6_ID}},{{T7_ID}} \
  --labels "refactor,migration,wave-3" \
  --description "Configure feature flag so new user registrations use JWT + bcrypt. Existing users remain on legacy until they log in and get upgraded." \
  --acceptance "New users get JWT auth" \
  --acceptance "New passwords use bcrypt" \
  --acceptance "Metrics show migration progress" \
  --notes "First production exposure - monitor closely"

# T9: Implement automatic user upgrade on login (Wave 3 - parallel)
{{TASK_ADD_CMD}} "Auto-upgrade users to new auth on login" \
  --type task \
  --size medium \
  --priority medium \
  --parent {{EPIC_ID}} \
  --phase core \
  --depends {{T6_ID}},{{T7_ID}} \
  --labels "refactor,migration,wave-3" \
  --description "When existing user logs in with valid MD5 password, transparently re-hash with bcrypt and migrate to JWT. User notices no change." \
  --acceptance "Login triggers automatic migration" \
  --acceptance "Password upgraded to bcrypt silently" \
  --acceptance "User receives JWT on next login" \
  --files "src/lib/auth/migration.ts"
```

### Wave 4: Cleanup (Final - Depends on T8, T9)

```bash
# T10: Monitor and validate migration completeness (Wave 4)
{{TASK_ADD_CMD}} "Validate migration completeness" \
  --type task \
  --size small \
  --priority medium \
  --parent {{EPIC_ID}} \
  --phase testing \
  --depends {{T8_ID}},{{T9_ID}} \
  --labels "refactor,validation,wave-4" \
  --description "Monitor migration metrics. Validate percentage of users migrated. Identify any stuck users. Plan forced migration for stragglers." \
  --acceptance "Migration dashboard shows >95%% users migrated" \
  --acceptance "Straggler users identified" \
  --acceptance "Forced migration plan for remaining users" \
  --notes "Shell escaping: Use \\$VARIABLE to prevent interpolation in notes"

# T11: Remove legacy auth code (Wave 4 - final cleanup)
{{TASK_ADD_CMD}} "Remove legacy auth code and feature flags" \
  --type task \
  --size medium \
  --priority low \
  --parent {{EPIC_ID}} \
  --phase polish \
  --depends {{T10_ID}} \
  --labels "refactor,cleanup,wave-4,tech-debt" \
  --description "After validation, remove legacy auth code, MD5 functions, session-based auth, and feature flags. Update documentation." \
  --acceptance "Legacy code removed" \
  --acceptance "Feature flags removed" \
  --acceptance "Documentation updated" \
  --acceptance "cleanupDone verification gate set" \
  --files "src/lib/auth/legacy/**"

# T12: Final regression testing (Wave 4 - depends on T11)
{{TASK_ADD_CMD}} "Final regression test suite" \
  --type task \
  --size small \
  --priority high \
  --parent {{EPIC_ID}} \
  --phase testing \
  --depends {{T11_ID}} \
  --labels "refactor,testing,wave-4,regression" \
  --description "Run full regression test suite from T2 against new auth system. All tests must pass. Verify no behavioral changes." \
  --acceptance "All baseline regression tests pass" \
  --acceptance "No behavioral regressions" \
  --acceptance "Performance benchmarks met"
```

---

## Step 4: Start Session

```bash
{{TASK_SESSION_START_CMD}} \
  --scope epic:{{EPIC_ID}} \
  --name "Auth Modernization - Refactor" \
  --agent ct-epic-architect \
  --auto-start
```

---

## Dependency Graph

```
Wave 0:
T1 (Impact Analysis)
T2 (Regression Baseline)
│
├──────────────────┐
▼                  ▼
Wave 1:
T3 (JWT Module)    T4 (Bcrypt)    T5 (Rollback Doc)
│                  │              │
└──────┬───────────┘              │
       ▼                          │
Wave 2:                           │
T6 (Adapter) ◄────────────────────┘
T7 (Integration Tests)
│
└──────┬───────────┐
       ▼           ▼
Wave 3:
T8 (New User Enable)  T9 (Auto-Upgrade)
│                     │
└──────────┬──────────┘
           ▼
Wave 4:
T10 (Validation)
▼
T11 (Legacy Removal)
▼
T12 (Final Regression)
```

---

## Wave Analysis

| Wave | Tasks | Parallel? | Rollback Point |
|------|-------|-----------|----------------|
| 0 | T1, T2 | Yes | N/A (no changes) |
| 1 | T3, T4, T5 | Yes | Disable feature flag |
| 2 | T6, T7 | Yes | Disable feature flag |
| 3 | T8, T9 | Yes | Rollback to Wave 2 |
| 4 | T10, T11, T12 | No | Complex (point of no return after T11) |

---

## Critical Path

T1/T2 → T3 → T6 → T8 → T10 → T11 → T12

---

## Refactor-Specific Safety Patterns

### 1. Strangler Fig Pattern
New code runs PARALLEL to legacy (T3, T4). Gradually shift traffic (T8, T9). Remove legacy last (T11).

### 2. Feature Flag Gates
Every wave has feature flag control:
- Wave 1: `auth_v2_module_enabled`
- Wave 3: `auth_v2_new_users_enabled`
- Wave 3: `auth_v2_auto_upgrade_enabled`

### 3. Regression Baseline First
ALWAYS create regression tests (T2) BEFORE any code changes. These are your safety net.

### 4. Rollback Checkpoints
Document rollback at each phase (T5). Test in staging before production.

### 5. Incremental Migration
Never big-bang cutover. Migrate users gradually (new users first, then auto-upgrade).

---

## Shell Escaping Reminder

When adding notes with special characters, escape `$` to prevent shell interpolation:

```bash
# CORRECT - escaped dollar sign
{{TASK_ADD_CMD}} "Task" --notes "Cost: \$500 per user"

# WRONG - $500 interpreted as variable
{{TASK_ADD_CMD}} "Task" --notes "Cost: $500 per user"
```

---

## Brownfield Checklist

Before starting any refactor epic:

- [ ] Impact analysis completed (T1)
- [ ] All integration points documented
- [ ] Regression baseline tests written (T2)
- [ ] Rollback procedure documented and tested
- [ ] Feature flags designed for gradual rollout
- [ ] Monitoring/metrics in place for migration tracking
- [ ] Legacy code preserved until validation complete
- [ ] No big-bang cutover - always gradual migration

---

## Verification Gates for Refactor

After completing refactor tasks, set verification gates:

```bash
# After implementation complete
{{TASK_VERIFY_CMD}} {{TASK_ID}} --gate testsPassed

# After QA review
{{TASK_VERIFY_CMD}} {{TASK_ID}} --gate qaPassed

# After cleanup/tech debt addressed (important for refactors)
{{TASK_VERIFY_CMD}} {{TASK_ID}} --gate cleanupDone

# After documentation updated
{{TASK_VERIFY_CMD}} {{TASK_ID}} --gate documented
```

---

## Key Design Decisions

1. **Impact Analysis First**: T1 maps dependencies before any changes
2. **Regression Baseline**: T2 creates safety net tests before modifications
3. **Parallel Implementation**: T3/T4 create new code alongside legacy (strangler fig)
4. **Adapter Pattern**: T6 enables gradual traffic shift via feature flags
5. **Gradual Migration**: T8/T9 migrate users incrementally, not all at once
6. **Cleanup Last**: T11 removes legacy only after validation (T10) confirms success
