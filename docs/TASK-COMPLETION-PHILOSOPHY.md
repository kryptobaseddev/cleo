# Task Completion Philosophy: "Always Be Shipping"

## Executive Summary

This document defines task sizing, completion criteria, and anti-patterns for agent-driven development in the claude-todo system. The core philosophy is **"Always Be Shipping"** - agents complete work and deploy to production, not endlessly plan.

**Key Metrics**:
- **Target Task Size**: 1-4 hours (single session)
- **WIP Limit**: 1 active task maximum
- **Execution Ratio**: 80% doing, 20% planning
- **Task Creation Budget**: Complete 1 task before creating 3 new ones
- **Deployment Frequency**: Daily minimum (multiple per day ideal)

## The Problem: Planning Paralysis

### Anti-Patterns to Prevent

| Anti-Pattern | Description | Impact |
|--------------|-------------|--------|
| **Analysis Paralysis** | Excessive analysis/planning with no implementation progress | Projects stall, never ship |
| **Infinite Decomposition** | Creating 20+ tasks before starting any work | Overhead exceeds value |
| **Research Black Holes** | "Research" tasks without deliverable artifacts | Tasks never complete |
| **Death by Planning** | Attempting to schedule every detail upfront | No room for learning/adaptation |
| **Blocked Task Chains** | Long dependency chains that stall all progress | Flow obstruction |
| **Context Switching** | Multiple active tasks simultaneously | 40% productivity loss |

### Root Causes

1. **Perceived importance**: Viewing decisions as "too important to get wrong"
2. **Lack of focus**: No clear priorities or WIP limits
3. **No time-boxing**: Planning activities without deadlines
4. **Missing iterative culture**: Waterfall mindset vs. MVP approach

## Minimum Viable Task Size

### Research-Backed Guidelines

**Context Switching Cost**:
- Takes **23-45 minutes** to restore flow state after interruption
- Multitasking with 3 tasks reduces productivity by **40%**
- Interrupted work contains **25% more errors**
- Developers lose focus every **6 minutes** on average

**Task Size Thresholds**:
- **Too Big**: >1 day (8 hours) - agent loses context, gets stuck
- **Too Small**: <1 hour - overhead exceeds value
- **Sweet Spot**: **1-4 hours** - completable in single focused session

**Industry Standards**:
- Agile guideline: Tasks should not exceed **5 days**
- Trunk-based development: Story sizes average **~1 day**
- High-performance teams: Branches live **<1 day** before merge
- Elite teams: Code changes reach production in **<1 hour**

### AI Agent-Specific Constraints

Current AI capabilities (as of 2025):
- **~100% success** on tasks taking humans <4 minutes
- **<10% success** on tasks taking humans >4 hours
- Task completion length doubling every **7 months** (6-year trend)

**Implication**: For current models, optimal task size is **1-4 hours of human work**, which maps to the "Sweet Spot" identified above.

## Epic/Story/Task Hierarchy

### Mapping to Shippable Increments

```
Epic (Release/Milestone)
├─ Story (PR-sized work)
│  ├─ Task (Single commit)
│  ├─ Task (Single commit)
│  └─ Task (Single commit)
├─ Story (PR-sized work)
│  └─ Task (Single commit)
└─ Story (PR-sized work)
   └─ Task (Single commit)
```

| Level | Size | Completion Criteria | Deployment |
|-------|------|---------------------|------------|
| **Task** | Hours | Code committed, tests pass | Commit to trunk |
| **Story** | 1-3 days | PR merged, acceptance criteria met | Feature flag enabled |
| **Epic** | 1-2 weeks | All stories done, integrated | Production deployment |

### Trunk-Based Development Model

**Principles**:
1. **Single trunk/main branch** - all developers commit to one shared branch
2. **Short-lived branches** - <1 day lifespan, merged frequently
3. **Small, frequent commits** - multiple times per day
4. **Feature flags** - decouple deployment from release
5. **Always green** - trunk is deployable at any commit

**Benefits**:
- Eliminates long-lived branch merge conflicts
- Enables continuous integration/deployment
- Faster code review (smaller changes)
- Reduces mean time to recovery (easier rollback)

## Completion Criteria

### Definition of Done (Universal)

Applies to **ALL** tasks across the project. Established upfront, consistent throughout.

**Checklist Format**:
- [ ] Code fully integrated into trunk/main
- [ ] All tests passing (unit, integration, E2E)
- [ ] Code reviewed and approved
- [ ] Documentation updated (if applicable)
- [ ] No unresolved bugs or regressions
- [ ] Meets security/performance standards

### Acceptance Criteria (Per-Task)

Unique for each user story. Specific, measurable, testable.

**Example** (for "Add JWT authentication"):
- [ ] Users can log in with email/password
- [ ] JWT token issued on successful login
- [ ] Protected routes validate JWT
- [ ] Expired tokens return 401 error
- [ ] Refresh token mechanism implemented

### Agent-Specific Completion Rules

**Task Completion**:
1. Code **committed** to version control (not just written)
2. Tests **passing** in CI (not just local)
3. Documentation **updated** (if needed)

**Story Completion**:
1. PR **merged** (not just submitted)
2. All acceptance criteria **met**
3. Feature **deployed** behind feature flag (if applicable)

**Epic Completion**:
1. All stories **done**
2. Integrated and **tested** end-to-end
3. **Deployed to production** (not just "ready")

### Both DoD and AC Must Be Met

A task is **NOT** complete unless:
- ✅ Definition of Done checklist satisfied
- ✅ Acceptance Criteria all met
- ✅ Agent-specific rules followed

## Work-in-Progress (WIP) Limits

### Purpose

- **Force focus** on completing over starting
- **Make blockers visible** before they become critical
- **Encourage "done" culture** vs. "almost done"
- **Reduce context switching** overhead

### Recommended Limits

**For Human Teams**:
- Start with: `team members + 1`
- Slightly below max capacity (room for unexpected)
- Example: 8 developers → 6 WIP limit

**For AI Agents**:
- **1 active task maximum** (enforced focus)
- Focus set via `claude-todo focus set <id>`
- All other tasks remain `pending` or `blocked`

### Pull System Behavior

When WIP limit is reached:
1. **Stop** starting new tasks
2. **Help** upstream or downstream work (code reviews, unblocking)
3. **Complete** in-progress work before new starts

**Benefit**: Whole team moves faster when work flows smoothly vs. everyone starting new tasks simultaneously.

## Task:Planning Ratio

### Research Findings

**No specific ratio exists**, but clear patterns emerge:
- Agile philosophy: Planning has **diminishing returns**
- Over-planning is anti-pattern (waste)
- **Value comes from execution**, not planning
- Planning variance >5% from execution = project at risk

### Practical Guidelines for Agents

**Target Ratios**:
- **80% execution** (coding, testing, deploying)
- **20% planning/coordination** (analysis, design, review)

**Hard Limits**:
- **Never >30%** time in planning activities
- If planning takes >30%, stop and execute what you know

**Task Creation Budget**:
- **Max 3-5 tasks** created per task completed
- Complete **1 task** before creating **3 new ones** (1:3 ratio)

**Planning Session Time-Boxing**:
- **15-30 minutes** maximum per planning session
- Set timer, when it expires, start executing

## Preventing Planning Paralysis

### Solutions

1. **Time-box planning** - hard 15-30 minute deadline
2. **Clear priorities** - know what's most important
3. **Iterative development** - MVP approach, small batches
4. **Reward action** - value executing (even with mistakes) over perfect plans
5. **Pull systems** - help blocked work vs. starting new tasks
6. **No "research" tasks** - every task must produce deliverable artifact

### "NoEstimates" Approach

Instead of estimating story points or hours:
1. **Break work into small, similar chunks** (1-3 days each)
2. **Measure throughput** (stories completed per sprint/week)
3. **Project timelines** using historical velocity
4. **Focus on shipping** the most valuable thing next

**Benefit**: Eliminates waste and false certainty of traditional estimation.

## Deployment Frequency Best Practices

### High-Performance Targets

| Team Level | Deployment Frequency | Batch Size | Lead Time |
|------------|---------------------|------------|-----------|
| **Elite** | Multiple per day | <4 hours work | <1 hour |
| **High** | Daily | <1 day work | <1 day |
| **Medium** | Weekly | <5 days work | <1 week |
| **Low** | Monthly+ | Weeks of work | Weeks to months |

**Target**: Daily minimum, multiple per day ideal.

### Technical Practices

**Required**:
- ✅ **Test automation** (unit, integration, E2E)
- ✅ **Observability** (logging, monitoring, alerts)
- ✅ **Feature flags** (decouple release from deploy)
- ✅ **Trunk-based development** (short-lived branches)

**Recommended**:
- Progressive delivery (canary, blue-green deployments)
- Automated rollbacks based on metrics
- Declarative infrastructure (IaC)

### Small Batch Benefits

- **Faster feedback** cycles (catch bugs early)
- **Lower deployment risk** (smaller blast radius)
- **Simplified testing** (fewer variables)
- **Easier rollback** (pinpoint changes quickly)
- **Improved psychological safety** (safe to experiment)

## Agent Autonomy and Task Completion

### L5 Autonomy (Fully Autonomous)

**Characteristics**:
- Plans and executes over long time horizons
- Makes all decisions independently
- Iterates on solutions when blocked
- No user involvement required

**Current Limitations**:
- Struggles with **long action sequences** more than individual steps
- <10% success on tasks >4 hours (human equivalent)
- Best suited for tasks <4 hours (focus on incremental progress)

### Task Completion as Core Metric

**Primary Evaluation Criterion**: Did the agent complete the task?

**Definition Varies by Context**:
- **Code task**: Committed to version control
- **Story task**: PR merged and deployed
- **Epic task**: Production deployment

**Include Stopping Conditions**:
- Max iterations (e.g., 5 attempts before escalation)
- Time limits (e.g., 4 hours before decomposition)
- Quality gates (e.g., tests must pass before commit)

## Practical Rules for claude-todo

### Task Creation Rules

1. ✅ **Create task only if >1 hour of work**
   - Smaller work goes directly in session notes, not separate tasks
2. ✅ **Max 5 pending tasks at once** (WIP limit)
   - Archive or complete tasks before creating more
3. ✅ **Complete 1 task before creating 3 new ones** (1:3 ratio)
   - Prevents runaway task creation
4. ✅ **No "research" tasks without deliverable**
   - "Research JWT auth" → "Document JWT auth options in ADR"
   - Every task must produce concrete artifact

### Task Execution Rules

1. ✅ **Set 1 active task** (`claude-todo focus set <id>`)
   - Enforced focus, no simultaneous active tasks
2. ✅ **Work until completion or blocked**
   - Don't switch tasks mid-stream unless truly blocked
3. ✅ **When blocked, help other tasks**
   - Review code, update docs, unblock dependencies
   - Don't immediately start new task
4. ✅ **Commit code within 4 hours or decompose**
   - If >4 hours without commit, task is too big
   - Break into smaller tasks and complete incrementally

### Completion Criteria Enforcement

**Task Level**:
- [ ] Code committed to version control
- [ ] Tests passing (if applicable)
- [ ] Documentation updated (if needed)

**Story Level**:
- [ ] PR created and merged
- [ ] All acceptance criteria met
- [ ] Feature deployed behind flag (if needed)

**Epic Level**:
- [ ] All stories complete
- [ ] End-to-end integration tested
- [ ] Deployed to production

### Anti-Pattern Detection

**Abort if**:
- Creating >10 tasks in single session (planning paralysis)
- Task active >1 day without commit (too big, needs decomposition)
- >3 "research" tasks in backlog (deliverable artifacts missing)
- >5 blocked tasks in chain (flow obstruction, needs unblocking)

## Governance and Quality

### Quality Standards (SOLID)

**Functional**:
- Correctness, reliability, feature completeness

**Structural**:
- Code organization, maintainability, tech debt management

**Performance**:
- Speed, scalability, resource efficiency

**Security**:
- Vulnerability management, access control, data protection

### Risk Management

**Define**:
- Autonomy levels and decision boundaries
- Behavior monitoring mechanisms
- Audit trails for compliance

**Formalize**:
- Development policies (coding standards)
- Deployment policies (approval gates)
- Usage policies (acceptable automation)

## Summary: Always Be Shipping

### Core Principles

1. **Ship Early, Ship Often** - daily deployments minimum
2. **Small Batches** - 1-4 hour tasks, <1 day branches
3. **Focus** - 1 active task maximum (WIP limits)
4. **Execute** - 80% doing, 20% planning
5. **Complete** - code committed, tests passing, deployed

### What Success Looks Like

**Bad** (Planning Paralysis):
- 20 tasks created, 0 completed
- "Research" tasks with no deliverables
- Multiple active tasks, none progressing
- Weeks of planning, no code shipped

**Good** (Always Be Shipping):
- 5 tasks created, 3 completed, 2 in progress
- Every task produces artifact (code, docs, deployment)
- 1 active task, clear focus
- Daily commits, frequent deployments

### Key Metrics to Track

1. **Deployment frequency** - how often code reaches production
2. **Lead time** - keyboard to user's hands duration
3. **WIP count** - number of active tasks (target: 1)
4. **Task completion rate** - completed vs. created ratio (target: 1:3)
5. **Batch size** - hours of work per commit (target: <4)

---

## Sources

1. [Story Points: Estimation Guide for User Stories in Agile [2025] • Asana](https://asana.com/resources/story-points)
2. [Agile Planning, Estimation, and the Story Points Illusion](https://agility-at-scale.com/principles/agile-planning-story-points/)
3. [Analysis Paralysis - The Daily Software Anti-Pattern](https://exceptionnotfound.net/analysis-paralysis-the-daily-software-anti-pattern/)
4. [Analysis Paralysis | DevIQ](https://deviq.com/antipatterns/analysis-paralysis/)
5. [Work in Small Batches | Minimum Viable Continuous Delivery](https://minimumcd.org/practices/smallbatches/)
6. [Impact of Deployment Frequency and Batch Size | Aviator](https://www.aviator.co/blog/impact-of-deployment-frequency-and-batch-size-on-software-quality/)
7. [Small Batches. Continuous small steps are the key to… | Continuous Delivery](https://medium.com/continuousdelivery/small-batches-ef89207b45d)
8. [LLM Agent Evaluation: Assessing Tool Use, Task Completion, Agentic Reasoning, and More](https://www.confident-ai.com/blog/llm-agent-evaluation-complete-guide)
9. [Levels of Autonomy for AI Agents | Knight First Amendment Institute](https://knightcolumbia.org/content/levels-of-autonomy-for-ai-agents-1)
10. [Building Effective AI Agents](https://www.anthropic.com/research/building-effective-agents)
11. [Measuring AI Ability to Complete Long Tasks - METR](https://metr.org/blog/2025-03-19-measuring-ai-ability-to-complete-long-tasks/)
12. [Always. Be. Shipping.](https://blog.codinghorror.com/yes-but-what-have-you-done/)
13. [Always Be Shipping - Adam Drake](https://adamdrake.com/always-be-shipping.html)
14. [Working with WIP limits for kanban | Atlassian](https://www.atlassian.com/agile/kanban/wip-limits)
15. [The Ultimate Guide to WIP Limits in Kanban](https://businessmap.io/kanban-resources/getting-started/what-is-wip)
16. [Definition of Done vs Acceptance Criteria](https://www.visual-paradigm.com/scrum/definition-of-done-vs-acceptance-criteria/)
17. [Definition of Done vs. Acceptance Criteria: A complete guide | Nulab](https://nulab.com/learn/software-development/definition-of-done-vs-acceptance-criteria/)
18. [Trunk-based Development | Atlassian](https://www.atlassian.com/continuous-delivery/continuous-integration/trunk-based-development)
19. [Use Feature Flags for trunk-based development | Harness Developer Hub](https://developer.harness.io/docs/feature-flags/get-started/trunk-based-development/)
20. [Context Switching is Killing Your Productivity | DevOps Culture](https://www.software.com/devops-guides/context-switching)
21. [Context Switching: The Silent Killer of Developer Productivity - Hatica](https://www.hatica.io/blog/context-switching-killing-developer-productivity/)
22. [Planning vs Execution - DEV Community](https://dev.to/maurer/planning-vs-execution-45fe)
