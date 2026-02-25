# Feature Epic Example: User Authentication System

This example demonstrates a greenfield feature epic for implementing a new authentication system.

---

## Scenario

A SvelteKit application needs user authentication with:
- Email/password login
- JWT token management
- Protected routes middleware
- User session handling

---

## Step 1: Create the Epic

```bash
{{TASK_ADD_CMD}} "EPIC: User Authentication System" \
  --type epic \
  --size large \
  --priority high \
  --phase core \
  --labels "feature,auth,security,v1.0" \
  --description "Implement complete user authentication with email/password login, JWT tokens, protected routes, and session management. Greenfield implementation following security best practices." \
  --acceptance "All auth endpoints functional" \
  --acceptance "JWT tokens generated and validated" \
  --acceptance "Protected routes middleware working" \
  --acceptance "Integration tests passing" \
  --notes "Initial planning: Authentication system for SvelteKit app"
```

**Annotation**: Epic is `large` because it spans multiple systems (API, middleware, frontend). Phase is `core` because this is primary feature work.

---

## Step 2: Create Tasks with Dependencies

### Wave 0: Foundation (No Dependencies)

```bash
# T1: Schema and types (Wave 0 - no deps)
{{TASK_ADD_CMD}} "Define auth schema and types" \
  --type task \
  --size medium \
  --priority high \
  --parent {{EPIC_ID}} \
  --phase setup \
  --labels "schema,types,foundation" \
  --description "Create database schema for users, sessions, and tokens. Define TypeScript types for auth payloads." \
  --acceptance "User table schema defined" \
  --acceptance "Session/token types exported" \
  --acceptance "Zod validation schemas created" \
  --files "src/lib/db/schema/users.ts,src/lib/types/auth.ts"
```

**Annotation**: First task has NO dependencies, enabling immediate start. Wave 0 tasks are "entry points" into the epic.

### Wave 1: Core Implementation (Depends on T1)

```bash
# T2: JWT utilities (Wave 1 - depends on T1)
{{TASK_ADD_CMD}} "Implement JWT token utilities" \
  --type task \
  --size medium \
  --priority high \
  --parent {{EPIC_ID}} \
  --phase core \
  --depends {{T1_ID}} \
  --labels "jwt,tokens,security" \
  --description "Create JWT generation, validation, and refresh functions using jose library." \
  --acceptance "Token generation function works" \
  --acceptance "Token validation with expiry check" \
  --acceptance "Refresh token rotation implemented" \
  --files "src/lib/auth/jwt.ts,src/lib/auth/tokens.ts"

# T3: Password hashing (Wave 1 - depends on T1, parallel with T2)
{{TASK_ADD_CMD}} "Implement password hashing" \
  --type task \
  --size small \
  --priority high \
  --parent {{EPIC_ID}} \
  --phase core \
  --depends {{T1_ID}} \
  --labels "password,security,bcrypt" \
  --description "Implement secure password hashing using bcrypt with configurable salt rounds." \
  --acceptance "Hash function produces valid bcrypt hash" \
  --acceptance "Verify function compares correctly" \
  --acceptance "Timing-safe comparison used" \
  --files "src/lib/auth/password.ts"
```

**Annotation**: T2 and T3 both depend only on T1, so they can run in PARALLEL. This is a "parallel fork" pattern.

### Wave 2: API Layer (Depends on T2 and T3)

```bash
# T4: Auth API endpoints (Wave 2 - depends on T2, T3)
{{TASK_ADD_CMD}} "Create auth API endpoints" \
  --type task \
  --size medium \
  --priority high \
  --parent {{EPIC_ID}} \
  --phase core \
  --depends {{T2_ID}},{{T3_ID}} \
  --labels "api,endpoints,auth" \
  --description "Implement /api/auth/register, /api/auth/login, /api/auth/logout, /api/auth/refresh endpoints." \
  --acceptance "Register endpoint creates user" \
  --acceptance "Login endpoint returns JWT" \
  --acceptance "Logout invalidates session" \
  --acceptance "Refresh endpoint rotates token" \
  --files "src/routes/api/auth/+server.ts,src/routes/api/auth/[action]/+server.ts"
```

**Annotation**: T4 is a "convergence point" - it depends on BOTH parallel branches (T2 AND T3). Must wait for both to complete.

### Wave 3: Middleware (Depends on T4)

```bash
# T5: Protected routes middleware (Wave 3 - depends on T4)
{{TASK_ADD_CMD}} "Implement protected routes middleware" \
  --type task \
  --size medium \
  --priority medium \
  --parent {{EPIC_ID}} \
  --phase core \
  --depends {{T4_ID}} \
  --labels "middleware,routes,protection" \
  --description "Create hooks.server.ts middleware to validate JWT on protected routes and inject user into locals." \
  --acceptance "Middleware validates JWT" \
  --acceptance "Unauthenticated requests redirected" \
  --acceptance "User available in locals" \
  --files "src/hooks.server.ts,src/lib/auth/middleware.ts"
```

### Wave 4: Testing (Depends on T5)

```bash
# T6: Integration tests (Wave 4 - depends on T5)
{{TASK_ADD_CMD}} "Write auth integration tests" \
  --type task \
  --size medium \
  --priority medium \
  --parent {{EPIC_ID}} \
  --phase testing \
  --depends {{T5_ID}} \
  --labels "testing,integration,auth" \
  --description "Write integration tests for complete auth flow: register, login, protected access, logout." \
  --acceptance "Registration flow test passes" \
  --acceptance "Login/logout flow test passes" \
  --acceptance "Protected route test passes" \
  --acceptance "Token refresh test passes" \
  --files "tests/auth.test.ts"
```

---

## Step 3: Start Session

```bash
{{TASK_SESSION_START_CMD}} \
  --scope epic:{{EPIC_ID}} \
  --name "Auth System - Development" \
  --agent ct-epic-architect \
  --auto-start
```

---

## Dependency Graph

```
T1 (Schema)
├──> T2 (JWT)
│    └──> T4 (API)
└──> T3 (Password)
     └──> T4 (API)
          └──> T5 (Middleware)
               └──> T6 (Tests)
```

---

## Wave Analysis

| Wave | Tasks | Parallel? | Notes |
|------|-------|-----------|-------|
| 0 | T1 | - | Entry point |
| 1 | T2, T3 | Yes | Both depend only on T1 |
| 2 | T4 | No | Convergence point |
| 3 | T5 | No | Sequential |
| 4 | T6 | No | Final validation |

---

## Critical Path

T1 → T2 → T4 → T5 → T6

(T3 runs parallel to T2, both converge at T4)

---

## Key Design Decisions

1. **Schema First**: T1 defines types before implementation - prevents refactoring
2. **Parallel Security**: JWT (T2) and password (T3) are independent modules
3. **API Convergence**: Endpoints (T4) need BOTH modules complete
4. **Test Last**: Integration tests (T6) run after all implementation done
