# Research Epic Examples

This document shows three research epic patterns: Exploratory, Decision, and Codebase Analysis.

---

## Pattern 1: Exploratory Research

### Scenario

Team wants to understand options for real-time collaboration features.

```bash
{{TASK_ADD_CMD}} "Research: Real-Time Collaboration Options" \
  --type epic \
  --size medium \
  --priority medium \
  --phase core \
  --labels "research,exploratory,realtime,collaboration" \
  --description "Research questions: (1) What real-time tech options exist? (2) What are trade-offs? (3) What's feasible for our stack? Success criteria: Documented options with recommendations." \
  --acceptance "3+ options documented" \
  --acceptance "Trade-offs analyzed" \
  --acceptance "Recommendation provided"
```

### Tasks

```bash
# T1: Define research scope (Wave 0)
{{TASK_ADD_CMD}} "Define collaboration research scope" \
  --type task \
  --size small \
  --parent {{EPIC_ID}} \
  --phase core \
  --labels "research,scope" \
  --description "Define specific research questions, constraints, and success criteria for real-time collaboration research."

# T2-T4: Parallel investigation (Wave 1)
{{TASK_ADD_CMD}} "Research WebSocket solutions" \
  --type task \
  --size medium \
  --parent {{EPIC_ID}} \
  --phase core \
  --depends {{T1_ID}} \
  --labels "research,websocket"

{{TASK_ADD_CMD}} "Research CRDT libraries" \
  --type task \
  --size medium \
  --parent {{EPIC_ID}} \
  --phase core \
  --depends {{T1_ID}} \
  --labels "research,crdt"

{{TASK_ADD_CMD}} "Research operational transform" \
  --type task \
  --size medium \
  --parent {{EPIC_ID}} \
  --phase core \
  --depends {{T1_ID}} \
  --labels "research,ot"

# T5: Synthesis (Final Wave)
{{TASK_ADD_CMD}} "Synthesize collaboration research findings" \
  --type task \
  --size medium \
  --parent {{EPIC_ID}} \
  --phase core \
  --depends {{T2_ID}},{{T3_ID}},{{T4_ID}} \
  --labels "research,synthesis" \
  --description "Aggregate findings from all investigation tasks, create comparison matrix, provide recommendation."
```

**Wave Structure**: Scope → Parallel Investigation → Synthesis

---

## Pattern 2: Decision Research

### Scenario

Team needs to choose between Drizzle ORM and Prisma for database layer.

```bash
{{TASK_ADD_CMD}} "Research: Drizzle vs Prisma ORM Selection" \
  --type epic \
  --size small \
  --priority high \
  --phase setup \
  --labels "research,decision,orm,database" \
  --description "Decision research: Compare Drizzle and Prisma for our SvelteKit stack. Criteria: type safety, performance, DX, migration story. Output: Decision matrix with recommendation." \
  --acceptance "Both ORMs evaluated against criteria" \
  --acceptance "Decision matrix completed" \
  --acceptance "Clear recommendation with rationale"
```

### Tasks

```bash
# T1: Define criteria (Wave 0)
{{TASK_ADD_CMD}} "Define ORM evaluation criteria" \
  --type task \
  --size small \
  --parent {{EPIC_ID}} \
  --phase setup \
  --labels "research,criteria" \
  --description "Define weighted evaluation criteria: type safety (30%), performance (25%), DX (25%), migrations (20%)"

# T2-T3: Parallel evaluation (Wave 1)
{{TASK_ADD_CMD}} "Evaluate Drizzle ORM" \
  --type task \
  --size medium \
  --parent {{EPIC_ID}} \
  --phase setup \
  --depends {{T1_ID}} \
  --labels "research,drizzle" \
  --description "Evaluate Drizzle against criteria. Build small PoC if needed."

{{TASK_ADD_CMD}} "Evaluate Prisma ORM" \
  --type task \
  --size medium \
  --parent {{EPIC_ID}} \
  --phase setup \
  --depends {{T1_ID}} \
  --labels "research,prisma" \
  --description "Evaluate Prisma against criteria. Build small PoC if needed."

# T4: Decision matrix (Wave 2)
{{TASK_ADD_CMD}} "Create ORM decision matrix" \
  --type task \
  --size small \
  --parent {{EPIC_ID}} \
  --phase setup \
  --depends {{T2_ID}},{{T3_ID}} \
  --labels "research,decision" \
  --description "Create weighted decision matrix, calculate scores, provide final recommendation."
```

**Wave Structure**: Criteria → Parallel Evaluation → Decision Matrix

---

## Pattern 3: Codebase Analysis

### Scenario

New team member needs to understand existing authentication architecture before making changes.

```bash
{{TASK_ADD_CMD}} "Research: Auth System Architecture Analysis" \
  --type epic \
  --size medium \
  --priority medium \
  --phase setup \
  --labels "research,codebase-analysis,auth,architecture" \
  --description "Analyze existing auth system architecture: components, data flows, dependencies, pain points. Output: Architecture documentation with improvement recommendations." \
  --acceptance "Architecture diagram created" \
  --acceptance "Data flows documented" \
  --acceptance "Pain points identified" \
  --acceptance "Improvement recommendations provided"
```

### Tasks

```bash
# T1: Architecture mapping (Wave 0)
{{TASK_ADD_CMD}} "Map auth system architecture" \
  --type task \
  --size medium \
  --parent {{EPIC_ID}} \
  --phase setup \
  --labels "research,architecture" \
  --description "Identify all auth-related files, create high-level architecture diagram."

# T2-T4: Parallel analysis (Wave 1)
{{TASK_ADD_CMD}} "Analyze auth dependencies" \
  --type task \
  --size small \
  --parent {{EPIC_ID}} \
  --phase setup \
  --depends {{T1_ID}} \
  --labels "research,dependencies" \
  --description "Map internal and external dependencies of auth system."

{{TASK_ADD_CMD}} "Trace auth data flows" \
  --type task \
  --size medium \
  --parent {{EPIC_ID}} \
  --phase setup \
  --depends {{T1_ID}} \
  --labels "research,dataflow" \
  --description "Document data flows: login, token refresh, logout, session validation."

{{TASK_ADD_CMD}} "Identify auth pain points" \
  --type task \
  --size small \
  --parent {{EPIC_ID}} \
  --phase setup \
  --depends {{T1_ID}} \
  --labels "research,pain-points" \
  --description "Review code for tech debt, complexity, and maintenance issues."

# T5: Recommendations (Final Wave)
{{TASK_ADD_CMD}} "Create auth improvement recommendations" \
  --type task \
  --size medium \
  --parent {{EPIC_ID}} \
  --phase setup \
  --depends {{T2_ID}},{{T3_ID}},{{T4_ID}} \
  --labels "research,recommendations" \
  --description "Synthesize analysis into actionable improvement recommendations prioritized by impact."
```

**Wave Structure**: Architecture → Parallel Deep Dives → Recommendations

---

## Research Task Atomicity

Each research task SHOULD address exactly ONE research question:

| Good | Bad |
|------|-----|
| "What WebSocket libraries exist for Node?" | "Research real-time options" |
| "Compare Drizzle query performance" | "Evaluate ORMs" |
| "Map auth token data flow" | "Understand auth system" |
