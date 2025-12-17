# "Always Be Shipping" - Task Completion Philosophy for Agents

## Research Summary: Task Sizing and Completion for AI Agents

### Core Philosophy: "Always Be Shipping"

**Definition**: Derived from "Always Be Closing" (Glengarry Glen Ross), adapted for software development. Philosophy emphasizes continuous delivery, maintaining momentum, and prioritizing real-world feedback over endless discussion.

**Key Principle**: Developers judged by what they ship, not meta-discussion around it. Perfect business cases, project plans, requirements don't matter until software ships.

### Minimum Viable Task Size

**Research Findings on Task Length**:
- Tasks >5 days should be decomposed (common guideline)
- Optimal target: 1-3 days per task (small batch principle)
- Paul Hammant (Trunk-Based Development): "Story sizes should average as close to one day as possible"
- Current AI models: ~100% success on tasks <4 minutes, <10% success on tasks >4 hours
- AI task completion length doubling every 7 months (6-year trend)

**Context Switching Cost**:
- Takes 23-45 minutes to restore flow state after interruption
- Multitasking reduces productivity by 40% (3 concurrent tasks)
- Interrupted work contains 25% more errors
- Context switching costs $50K/developer/year
- Developers check communication tools 150+ times daily (every 6 minutes)

**Optimal Task Structure**:
- **Too Big**: Agent loses context, gets stuck in analysis paralysis
- **Too Small**: Overhead exceeds value, constant task switching
- **Sweet Spot**: 1-4 hours of focused work, completable in single session

### Epic/Story/Task Mapping to Shippable Increments

**Hierarchy**:
- **Epic** → Release/Milestone (deployable product increment)
- **Story** → PR-sized work (1-3 days, independently deployable with feature flags)
- **Task** → Single commit (hours, atomic change)

**Trunk-Based Development Model**:
- Branches <1 day lifespan
- Small, frequent commits to main/trunk
- Feature flags decouple deployment from release
- Trunk stays "green" (deployable at any commit)

**Small Batch Benefits**:
- Faster feedback cycles
- Lower deployment risk
- Simplified testing and rollback
- Reduced mean time to recover
- Improved psychological safety

### Completion Criteria (Definition of Done)

**Definition of Done (Universal)**:
- Applies to ALL tasks/stories in project
- Established upfront, consistent throughout
- Checklist format (code integrated, tests pass, docs complete, no bugs, approval)
- Team agreement, revisited periodically

**Acceptance Criteria (Per-Task)**:
- Unique for each user story
- Specific, measurable, testable
- Created collaboratively during planning
- Recorded with each story

**Both must be met for task completion**

**Agent-Specific Completion Criteria**:
1. **Task Done** = Code committed to trunk (not just written)
2. **Story Done** = PR merged + tests pass (not just submitted)
3. **Epic Done** = Deployed to production (not just "ready")

### Preventing Planning Paralysis

**Anti-Patterns Identified**:
- **Analysis Paralysis**: Excessive planning/analysis, no implementation progress
- **Death by Planning**: Attempting to schedule every detail, no contingency
- **Decision Paralysis**: Endless debate over alternatives, no action
- **Overanalysis**: Too much time planning vs. executing

**Root Causes**:
- Viewing decisions as "too important to get wrong"
- Lack of clear priorities
- No time-boxing for planning activities
- No iterative development culture

**Solutions**:
1. Time-box planning activities (hard deadlines)
2. Establish clear goals/priorities upfront
3. Embrace iterative development (MVP approach)
4. Reward action-oriented behavior (even with mistakes)
5. Work in small batches (1-3 days max)
6. Use "pull systems" (help blocked work vs. starting new)

### Work-in-Progress (WIP) Limits

**Purpose**: Force focus, make blockers visible, encourage "done" culture

**Recommended Limits**:
- Start with: team members + 1
- Slightly below max capacity (room for unexpected)
- Example: 8 developers → 6 WIP limit (pairs/individuals)
- **Agent Context**: 1 active task maximum (enforced focus)

**Benefits**:
- Reduces context switching
- Improves flow efficiency
- Makes bottlenecks visible early
- Prevents overburdening
- Drops cycle time when working correctly

**Pull System Effect**: When WIP reached, help upstream/downstream vs. starting new work

### Task:Planning Ratio

**Research Consensus**: No specific ratio found, but clear patterns:
- Agile philosophy: Planning has diminishing returns
- Over-planning is anti-pattern (waste)
- Value comes from execution, not planning
- Planning should inform execution, execution should inform future planning

**Practical Guidelines**:
- Planning variance >5% from execution = project at risk
- Minimum Viable Product (MVP) approach preferred
- Continuous small steps > comprehensive upfront planning
- "NoEstimates" movement: Use throughput vs. estimation

**Agent-Specific Recommendation**:
- **Target**: 80% execution, 20% planning/coordination
- **Hard Limit**: Never >30% time in planning activities
- **Task Creation Budget**: Max 3-5 tasks created per task completed
- **Planning Session**: Time-boxed to 15-30 minutes max

### Deployment Frequency Best Practices

**High-Performance Targets**:
- Multiple deploys per day (elite teams)
- Minimum: Daily deployments
- Batch size: <1 day of work
- Lead time: Keyboard → user hands in <1 hour (microservices)

**Technical Practices**:
- Test automation (mandatory)
- Observability/monitoring
- Feature flags (decouple release from deploy)
- Progressive delivery (canary, blue-green)
- Trunk-based development
- Automated rollbacks based on metrics

### Agent Autonomy Levels and Task Completion

**L5 Autonomy (Fully Autonomous)**:
- Plans/executes over long time horizons
- Makes all decisions independently
- Iterates on solutions when blocked
- No user involvement required/available

**Task Completion as Core Metric**:
- Primary evaluation criterion for agent effectiveness
- Definition varies by context (code committed, PR merged, deployed)
- Should include stopping conditions (max iterations for control)

**Agent Ideal Use Cases**:
- Open-ended problems (unpredictable steps)
- Cannot hardcode fixed path
- Requires multi-turn operation
- Trusted environment for autonomy

**Current Limitations**:
- Struggle with long action sequences more than individual steps
- <10% success on tasks >4 hours (human time)
- Best at tasks <4 minutes (near 100%)

### Governance and Control

**Risk Management**:
- Define autonomy levels and decision boundaries
- Behavior monitoring and audit mechanisms
- Formal policies for development/deployment/usage
- Safety frameworks for autonomous task completion

**Quality Standards**:
- Functional: Correctness, reliability, completeness
- Structural: Organization, maintainability, tech debt
- Performance: Speed, scalability, efficiency
- Security: Vulnerabilities, access control, data protection

### Practical Rules for Agents

**Task Creation**:
1. Create task only if >1 hour of work
2. Max 5 pending tasks at once (WIP limit)
3. Complete 1 task before creating 3 new ones (1:3 ratio)
4. No "research" tasks without deliverable artifact

**Task Execution**:
1. Set 1 active task (enforced focus)
2. Work until completion or blocked
3. When blocked, help other tasks vs. starting new
4. Commit code within 4 hours or decompose further

**Completion Criteria**:
1. Code committed to version control
2. Tests passing (if applicable)
3. Documentation updated (if needed)
4. PR created/merged (story level)
5. Deployed (epic level)

**Anti-Patterns to Prevent**:
- Creating >20 tasks before starting any (planning paralysis)
- Infinite subtask decomposition (analysis paralysis)
- "Research" tasks that never complete (no deliverable)
- Long blocked task chains (flow obstruction)
- Multiple active tasks simultaneously (context switching)

### Sources

1. [Story Points: Estimation Guide for User Stories in Agile [2025] • Asana](https://asana.com/resources/story-points)
2. [Agile Planning, Estimation, and the Story Points Illusion](https://agility-at-scale.com/principles/agile-planning-story-points/)
3. [Analysis Paralysis - The Daily Software Anti-Pattern](https://exceptionnotfound.net/analysis-paralysis-the-daily-software-anti-pattern/)
4. [Analysis Paralysis | DevIQ](https://deviq.com/antipatterns/analysis-paralysis/)
5. [Work in Small Batches | Minimum Viable Continuous Delivery](https://minimumcd.org/practices/smallbatches/)
6. [Impact of Deployment Frequency and Batch Size | Aviator](https://www.aviator.co/blog/impact-of-deployment-frequency-and-batch-size-on-software-quality/)
7. [Small Batches. Continuous small steps are the key to… | by Leena | Continuous Delivery | Medium](https://medium.com/continuousdelivery/small-batches-ef89207b45d)
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
