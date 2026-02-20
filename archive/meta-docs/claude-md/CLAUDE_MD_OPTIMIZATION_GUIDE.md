# The Definitive CLAUDE.md Optimization Guide
## Strict Guidelines, Rules, and Best Practices for Maximum Claude Code Performance

---

## Table of Contents

1. [Core Principles](#core-principles)
2. [Memory Hierarchy & File Locations](#memory-hierarchy--file-locations)
3. [The Golden Rules](#the-golden-rules)
4. [File Structure Template](#file-structure-template)
5. [What to Include vs. Exclude](#what-to-include-vs-exclude)
6. [Progressive Disclosure Strategy](#progressive-disclosure-strategy)
7. [Subfolder CLAUDE.md Usage](#subfolder-claudemd-usage)
8. [Import System](#import-system)
9. [Maintenance & Evolution](#maintenance--evolution)
10. [Anti-Patterns to Avoid](#anti-patterns-to-avoid)
11. [Advanced Optimization Techniques](#advanced-optimization-techniques)
12. [Complete Examples](#complete-examples)

---

## Core Principles

### The Fundamental Truth

CLAUDE.md is injected into Claude's system prompt for EVERY session. This makes it the **highest-leverage point** in your Claude Code workflow—for better or worse. A bad line in CLAUDE.md affects every single artifact, plan, and piece of code Claude produces.

### The Three Pillars

Every CLAUDE.md must answer three questions:

1. **WHAT**: Tech stack, project structure, key files, dependencies
2. **WHY**: Project purpose, architectural decisions, business context
3. **HOW**: Commands, workflows, verification steps, deployment procedures

### Cognitive Budget Reality

**CRITICAL**: Research indicates:
- Frontier LLMs can reliably follow ~150-200 instructions
- Claude Code's system prompt already contains ~50 instructions
- This leaves you ~100-150 instructions maximum for your CLAUDE.md
- Instruction-following degrades **uniformly** as count increases (not just for newer instructions)
- Smaller models exhibit exponential decay in instruction-following

---

## Memory Hierarchy & File Locations

### Load Order (Top to Bottom = First to Last)

| Priority | Location | Purpose | Scope |
|----------|----------|---------|-------|
| 1 (First) | Enterprise Policy (`/Library/Application Support/ClaudeCode/CLAUDE.md` on macOS) | Organization standards | All users |
| 2 | User Global (`~/.claude/CLAUDE.md`) | Personal preferences | All your projects |
| 3 | Project Root (`./CLAUDE.md` or `./.claude/CLAUDE.md`) | Team-shared project context | This project |
| 4 | Project Local (`./CLAUDE.local.md`) | Personal project overrides | This project, not committed |
| 5 (Last) | Subdirectory (`./subdir/CLAUDE.md`) | Module-specific context | On-demand when files accessed |

**Key Insight**: Files loaded later can override earlier files. Subdirectory files are loaded **on-demand** when Claude accesses files in those directories, not at startup.

### Recommended Setup

```
~/.claude/
├── CLAUDE.md                    # Your global preferences
├── commands/                    # Personal slash commands
│   └── security-review.md

/your-project/
├── CLAUDE.md                    # Team-shared (commit to git)
├── CLAUDE.local.md              # Personal overrides (gitignored)
├── .claude/
│   └── commands/                # Project slash commands
│       └── fix-issue.md
├── docs/
│   ├── architecture.md          # Import target
│   ├── conventions.md           # Import target
│   └── workflows.md             # Import target
├── frontend/
│   └── CLAUDE.md                # Frontend-specific rules
└── backend/
    └── CLAUDE.md                # Backend-specific rules
```

---

## The Golden Rules

### Rule 1: Less Is More (MANDATORY)

```
TARGET: < 100 lines for root CLAUDE.md
IDEAL:  < 60 lines
MAXIMUM: 300 lines (absolute ceiling)
```

**Why**: Every token in CLAUDE.md competes with your actual task context. Bloated files = degraded performance + higher costs.

### Rule 2: Universal Applicability Only

Every line in root CLAUDE.md must be relevant to **90%+ of sessions**. If something only matters for specific tasks, use:
- Subdirectory CLAUDE.md files
- Import files with `@path/to/file.md`
- Slash commands for task-specific workflows

### Rule 3: Be Specific, Not Vague

```markdown
# ❌ BAD - Vague
- Write good code
- Follow best practices
- Format code properly

# ✅ GOOD - Specific
- Use 2-space indentation for TypeScript/JavaScript
- Max function length: 50 lines
- Prefix private methods with underscore
```

### Rule 4: Use Emphasis Strategically

For critical instructions that MUST be followed:

```markdown
**IMPORTANT**: Never commit directly to main branch
**CRITICAL**: All database migrations must be backward compatible
**REQUIRED**: Run `npm run typecheck` before committing
```

### Rule 5: Never Use Claude as a Linter

Claude is expensive and slow for formatting. Use deterministic tools:

```markdown
# ❌ BAD - Don't do this
- Ensure code follows PEP 8
- Check for unused imports
- Verify consistent spacing

# ✅ GOOD - Reference your tools
- Run `npm run lint` to check formatting (Biome)
- Pre-commit hooks handle formatting automatically
```

### Rule 6: Never Include Time Estimates (MANDATORY)

```markdown
# ❌ BAD - Time estimates create false precision
- This task will take 2-3 hours
- Implementation: ~1 week
- Estimated completion: Friday

# ✅ GOOD - Scope-based descriptions
- Scope: Modify 3 files, add 2 new components
- Complexity: Medium (requires API integration)
- Dependencies: Blocked by auth system completion
- Relative size: Medium (comparable to feature X)
```

**Why Time Estimates Are Prohibited:**

1. **Planning Fallacy**: Research by Kahneman & Tversky shows only 30% of people complete tasks within their predicted schedule—regardless of past experience with similar tasks.

2. **Hofstadter's Law**: "It always takes longer than you expect, even when you take into account Hofstadter's Law."

3. **LLMs Cannot Track Time**: LLMs have no internal clock, no "point-in-time notion," and cannot measure elapsed duration or predict interruptions. They also inherit human estimation biases from training data—so they don't improve accuracy, they replicate our systematic errors.

4. **Anchoring Bias**: Once a time estimate is given, it becomes a cognitive anchor that distorts all subsequent planning and prioritization decisions.

5. **False Precision**: "2-3 days" sounds precise but is actually a guess. This false precision leads to poor resource allocation and unrealistic expectations.

6. **AI Doesn't Help**: The METR study (2025) found that AI tools made experienced developers **19% slower**, not faster. Even with AI assistance, time estimates remain unreliable—the relationship between AI usage and completion time is not straightforward.

**What To Do Instead:**

- Describe **scope**: files affected, components involved, integration points
- Describe **complexity**: simple/medium/complex with reasoning
- Describe **dependencies**: what must happen first, what's blocked
- Use **relative sizing**: small/medium/large compared to known work
- State **unknowns**: what could expand scope, risks identified

**Handling User Requests for Time Estimates:**

If a user insists on time estimates, respond with:
> "I cannot provide accurate time predictions—research shows even humans complete tasks within their estimates only 30% of the time, and I have no ability to track time. Instead, let me describe the scope and complexity so you can make an informed decision."

### Rule 7: Pointers Over Copies

```markdown
# ❌ BAD - Inline code examples that will become stale
## Database Schema
```sql
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  ...
)
```

# ✅ GOOD - Reference the source of truth
## Database
- Schema definitions: `src/db/schema.ts`
- Migration docs: `docs/migrations.md`
- For schema questions, read `@src/db/schema.ts`
```

---

## File Structure Template

### Minimal Template (Recommended Starting Point)

```markdown
# Project Name

## Stack
- [Framework]: [Version]
- [Language]: [Version]
- [Key dependency]: [Purpose]

## Commands
- `[build command]`: Build the project
- `[test command]`: Run tests
- `[dev command]`: Start development server

## Structure
- `src/`: Source code
- `tests/`: Test files
- `docs/`: Documentation

## Rules
- [Most critical rule 1]
- [Most critical rule 2]
- [Most critical rule 3]
```

### Full Template (For Complex Projects)

```markdown
# [Project Name]

## Overview
[One sentence describing what this project does]

## Tech Stack
- Framework: [Name] [Version]
- Language: [Name] [Version]  
- Database: [Name]
- Key Libraries: [List critical ones only]

## Project Structure
```
src/
├── components/    # UI components
├── lib/           # Core utilities
├── services/      # Business logic
└── types/         # TypeScript definitions
```

## Essential Commands
- `npm run dev`: Start dev server (port 3000)
- `npm run build`: Production build
- `npm run test`: Run test suite
- `npm run typecheck`: TypeScript validation

## Workflow
1. Create feature branch from `main`
2. Implement changes with tests
3. Run `npm run typecheck && npm run test`
4. Create PR with conventional commit messages

## Code Conventions
- [3-5 most important conventions only]

## Architecture Decisions
- @docs/architecture.md

## Testing
- @docs/testing-guide.md
```

---

## What to Include vs. Exclude

### ✅ ALWAYS INCLUDE

| Category | Examples |
|----------|----------|
| **Build/Run Commands** | `npm run dev`, `python manage.py runserver` |
| **Test Commands** | `pytest`, `npm test -- --watch` |
| **Critical File Locations** | Where to find schemas, configs, entry points |
| **Non-Obvious Conventions** | Things Claude wouldn't guess from code |
| **Verification Steps** | How to validate changes work |
| **Branch/Commit Conventions** | If they differ from defaults |
| **Environment Setup** | `pyenv`, Docker requirements, etc. |

### ❌ NEVER INCLUDE

| Category | Why |
|----------|-----|
| **Time estimates** | LLMs cannot track time; creates false precision and anchoring bias |
| **Sensitive data** | API keys, credentials, connection strings |
| **Lengthy code examples** | They become stale; use file references |
| **Generic coding standards** | Claude learns from your existing code |
| **Information for specific tasks only** | Use imports or subdir CLAUDE.md |
| **Database schemas** | Reference the schema file instead |
| **Full API documentation** | Link to docs or import on demand |
| **Things linters handle** | Use actual linters |

### ⚠️ CONDITIONAL INCLUDE

Include **only if** not inferable from existing code:

- Naming conventions (if they're unusual)
- Import ordering rules (if you have specific requirements)
- Comment style requirements
- Error handling patterns

---

## Progressive Disclosure Strategy

### The Problem

You want Claude to know everything about your project, but putting it all in CLAUDE.md bloats context and degrades performance.

### The Solution

Keep task-specific information in separate files and tell Claude where to find them.

### Implementation

```markdown
# CLAUDE.md (Root - Always Loaded)

## Quick Reference
- Build: `npm run build`
- Test: `npm test`
- Dev: `npm run dev`

## Documentation Index
When working on specific areas, read the relevant docs first:

- **Architecture decisions**: @docs/architecture.md
- **API development**: @docs/api-conventions.md  
- **Frontend components**: @docs/component-patterns.md
- **Database changes**: @docs/database-guide.md
- **Testing**: @docs/testing-strategy.md
- **Deployment**: @docs/deployment.md

## Core Rules
[Only universally applicable rules here]
```

### Directory Structure for Progressive Disclosure

```
project/
├── CLAUDE.md                    # Minimal, universal instructions
├── docs/
│   ├── architecture.md          # Detailed architecture docs
│   ├── api-conventions.md       # API-specific rules
│   ├── testing-strategy.md      # Testing patterns
│   └── deployment.md            # Deployment procedures
├── frontend/
│   └── CLAUDE.md                # Frontend-specific (loaded on-demand)
├── backend/
│   └── CLAUDE.md                # Backend-specific (loaded on-demand)
└── scripts/
    └── CLAUDE.md                # Script-specific conventions
```

---

## Subfolder CLAUDE.md Usage

### When to Use Subfolder CLAUDE.md Files

| Use Case | Example |
|----------|---------|
| **Monorepos** | Different rules for `packages/web` vs `packages/api` |
| **Multi-language** | Python rules in `backend/`, TypeScript in `frontend/` |
| **Different domains** | `admin/` has different conventions than `customer/` |
| **Legacy code** | `legacy/` has different patterns than `v2/` |
| **Generated code** | `generated/` should never be manually edited |

### When NOT to Use Subfolder CLAUDE.md Files

- For information needed in every session (put in root)
- For rarely-accessed areas (use imports instead)
- For single-file exceptions (use inline comments)

### Subfolder CLAUDE.md Template

```markdown
# [Directory Name] Specific Rules

## Context
This directory contains [purpose]. It differs from the rest of the project because [reason].

## Additional Commands
- `[command]`: [purpose]

## Conventions Specific to This Directory
- [Rule that differs from or extends root]

## Files to Understand First
- `[key-file.ts]`: [why it's important]
```

### Loading Behavior

**Important**: Subdirectory CLAUDE.md files are NOT loaded at startup. They are loaded **on-demand** when Claude reads or modifies files in that directory.

---

## Import System

### Syntax

```markdown
# Direct import
@docs/architecture.md

# Import with context
See @README.md for project overview

# Import from home directory (for personal instructions not in repo)
@~/.claude/my-preferences.md

# Multiple imports
- Git workflow: @docs/git-instructions.md
- Testing: @docs/testing.md
```

### Import Rules

1. **Max depth**: 5 levels of recursive imports
2. **Code blocks**: Imports inside \`code spans\` or \`\`\`code blocks\`\`\` are ignored
3. **Paths**: Both relative and absolute paths work
4. **Home directory**: Use `@~/` for paths in your home directory

### Import Strategy

```markdown
# CLAUDE.md

## Core Instructions
[Minimal universal rules - ~20 lines]

## Extended Documentation
The following contain detailed guidance. Read before working in those areas:

### Architecture
@docs/architecture.md

### Per-Domain Rules  
- Frontend: @frontend/CONVENTIONS.md
- Backend: @backend/CONVENTIONS.md
- Database: @docs/database-patterns.md
```

### Anti-Pattern: Import Everything

```markdown
# ❌ BAD - Defeats the purpose of imports
@docs/everything.md
@src/all-patterns.md
@tests/all-conventions.md
[20 more imports...]

# ✅ GOOD - Selective, contextual imports
## Architecture Decisions
When making architectural changes, first read @docs/adr/README.md
```

---

## Maintenance & Evolution

### Initial Setup Workflow

1. **DON'T run `/init` blindly** - It generates verbose output that often needs heavy editing
2. **Start minimal** - Begin with just commands and critical rules
3. **Add through friction** - When you find yourself repeating instructions, add them
4. **Use `#` shortcut** - Press `#` during sessions to add memories on the fly

### Continuous Refinement

```bash
# Weekly review checklist
□ Remove anything that hasn't been relevant in 2+ weeks
□ Update commands if they've changed
□ Check that file references still point to correct locations
□ Remove duplicates created by # additions
□ Consolidate related instructions
```

### Team Workflow

1. **Commit CLAUDE.md to version control** - Share context with team
2. **Use CLAUDE.local.md for personal preferences** - Auto-gitignored
3. **Review CLAUDE.md changes in PRs** - High leverage = high scrutiny
4. **Share working additions** - When # additions work well, propose for team CLAUDE.md

### Prompt Improver Technique

Periodically refine your CLAUDE.md:

```
Please review this CLAUDE.md file and suggest improvements:
1. Remove redundant or vague instructions
2. Make instructions more specific and actionable
3. Identify anything that could be moved to imports
4. Add emphasis (IMPORTANT, CRITICAL) where needed
5. Improve organization and scanability
```

---

## Anti-Patterns to Avoid

### 1. The Kitchen Sink

```markdown
# ❌ Everything in one file
[500+ lines of every possible instruction]
```

**Fix**: Use progressive disclosure and imports.

### 2. The Aspirational Document

```markdown
# ❌ Theoretical best practices
- Always write comprehensive documentation
- Consider all edge cases
- Ensure 100% test coverage
```

**Fix**: Only include what actually matters for your project.

### 3. The Duplicate Repository

```markdown
# ❌ Copying your README
## About
[3 paragraphs about the project history...]
## Installation
[Full installation guide...]
```

**Fix**: `@README.md` if Claude needs this info.

### 4. The Style Guide

```markdown
# ❌ Extensive code style rules
- Use camelCase for variables
- Use PascalCase for classes
- Indent with 2 spaces
- Max line length 80
[50 more formatting rules...]
```

**Fix**: Configure a linter. Claude learns style from your existing code.

### 5. The Unreferenced Import

```markdown
# ❌ Imports nobody uses
@docs/old-architecture.md
@docs/deprecated-patterns.md
@legacy/README.md
```

**Fix**: Remove imports for files that aren't actively relevant.

### 6. The Inline Hotfix Accumulator

```markdown
# ❌ Band-aids instead of proper instructions
- DON'T use var, use const/let
- STOP putting console.log everywhere
- REMEMBER to add types
- PLEASE run tests
```

**Fix**: Consolidate into proper, structured instructions.

### 7. The Time Estimator

```markdown
# ❌ Time estimates that create false expectations
## Task Estimates
- Login feature: 2-3 days
- API integration: ~1 week
- Bug fixes: 4 hours each

## Sprint Planning
- Sprint capacity: 40 story points
- Velocity: 35 points/sprint
```

**Fix**: Replace with scope/complexity descriptions. Use relative sizing (small/medium/large) if needed. Never provide hours/days/weeks.

---

## Advanced Optimization Techniques

### 1. Repository-Specific Training

From Prompt Learning research: Training Claude on your specific repository's patterns can yield 10%+ improvement. Capture these patterns:

```markdown
## Repository Patterns
This codebase consistently:
- Uses factory functions over classes for services
- Handles errors with Result<T, E> pattern (see @src/lib/result.ts)
- Structures API responses as { data, error, meta }
```

### 2. Negative Instructions (Use Sparingly)

```markdown
## Boundaries
**NEVER**:
- Modify files in `/generated/`
- Commit directly to `main`
- Skip TypeScript strict mode

**ALWAYS ASK FIRST**:
- Before deleting any test files
- Before changing database schemas
- Before modifying CI/CD configs
```

### 3. Workflow Definitions

```markdown
## Standard Workflows

### Feature Development
1. Read relevant files first (don't write code yet)
2. Create implementation plan
3. Implement with tests
4. Run `npm run validate`
5. Create commit with conventional message

### Bug Fix
1. Reproduce the issue
2. Write failing test
3. Fix the code
4. Verify test passes
5. Check for regressions
```

### 4. Context Anchors

Add comments in critical code files that CLAUDE.md references:

```typescript
// CLAUDE: This is the main entry point. All requests flow through here.
// CLAUDE: Authentication happens in middleware, not here.
export async function handleRequest(req: Request) {
  // ...
}
```

```markdown
# CLAUDE.md
## Code Navigation
- Request handling: `src/server.ts` (look for CLAUDE comments)
- Auth flow: `src/middleware/auth.ts`
```

### 5. MCP Integration Notes

```markdown
## Available Tools
- Slack MCP: Use for #dev-notifications only (rate limited)
- GitHub MCP: Full access to repository operations
- Database MCP: Read-only access to production replica

For MCP debugging: `claude --mcp-debug`
```

---

## Complete Examples

### Example 1: Minimal SaaS Project (~40 lines)

```markdown
# TaskFlow - Task Management SaaS

## Stack
- Next.js 14 (App Router)
- TypeScript 5.3
- PostgreSQL + Drizzle ORM
- Tailwind CSS

## Commands
- `pnpm dev`: Start dev server (port 3000)
- `pnpm build`: Production build
- `pnpm test`: Run Vitest
- `pnpm db:push`: Push schema changes
- `pnpm db:studio`: Open Drizzle Studio

## Structure
- `src/app/`: Next.js routes and pages
- `src/components/`: React components
- `src/lib/`: Utilities and helpers
- `src/db/`: Database schema and queries

## Key Files
- Schema: `src/db/schema.ts`
- Auth: `src/lib/auth.ts`
- API utils: `src/lib/api.ts`

## Rules
- Use server components by default, client only when needed
- All database queries go through `src/db/queries/`
- Validate all inputs with Zod schemas
- **IMPORTANT**: Run `pnpm typecheck` before committing

## Docs
- Architecture: @docs/architecture.md
- API patterns: @docs/api.md
```

### Example 2: Monorepo (~50 lines in root)

```markdown
# Acme Platform Monorepo

## Workspace Structure
- `apps/web`: Customer-facing Next.js app
- `apps/admin`: Internal admin dashboard
- `apps/api`: Fastify API server
- `packages/ui`: Shared component library
- `packages/db`: Database client and schema
- `packages/utils`: Shared utilities

## Commands (Root)
- `pnpm dev`: Start all apps in dev mode
- `pnpm build`: Build all packages
- `pnpm test`: Run all tests
- `pnpm lint`: Lint everything

## Per-App Commands
Navigate to app directory, then use same commands.

## Workspace Rules
- **CRITICAL**: Changes to `packages/*` affect multiple apps
- Run `pnpm build` in package before testing dependent apps
- Shared types go in `packages/types`
- New packages need `turbo.json` entry

## App-Specific Docs
Each app has its own CLAUDE.md with specific instructions.

## Key Decisions
- @docs/adr/001-monorepo-structure.md
- @docs/adr/002-shared-packages.md
```

### Example 3: Python ML Project (~45 lines)

```markdown
# MLPipeline - Machine Learning Training System

## Environment
- Python 3.11 (use pyenv)
- Poetry for dependencies
- PyTorch 2.1

## Setup
```bash
pyenv local 3.11.0
poetry install
poetry shell
```

## Commands
- `poetry run train`: Start training
- `poetry run evaluate`: Run evaluation
- `poetry run pytest`: Run tests
- `poetry run jupyter lab`: Start notebooks

## Structure
- `src/models/`: Model definitions
- `src/data/`: Data loaders and preprocessing
- `src/training/`: Training loops
- `experiments/`: Experiment configs
- `notebooks/`: Exploration notebooks

## Rules
- Type hints required for all functions
- Docstrings follow NumPy style
- New models need test coverage
- **IMPORTANT**: Never commit model weights to git

## Experiment Tracking
- Use MLflow for all experiments
- Config in `experiments/*.yaml`
- Results logged to `mlruns/`

## GPU Usage
- Default: Single GPU (CUDA_VISIBLE_DEVICES=0)
- Multi-GPU: Use `torchrun` launcher
```

### Example 4: Global User CLAUDE.md (~30 lines)

```markdown
# ~/.claude/CLAUDE.md - My Global Preferences

## Communication Style
- Be concise and direct
- Skip unnecessary preambles
- Use bullet points for multiple items

## Code Preferences
- Prefer functional style over OOP
- Use descriptive variable names
- Add comments for non-obvious logic

## Formatting
- Use UK English spelling
- No emojis in commit messages
- 2-space indentation everywhere

## Git
- Conventional commits: `feat:`, `fix:`, `docs:`, etc.
- Always create feature branches
- Squash before merge

## Permissions
- Allow access to: docs.anthropic.com, github.com
- Allow access to: my-company-docs.internal

## Never
- Auto-commit without showing diff first
- Delete branches without confirmation
- Push to main directly
```

---

## Quick Reference Checklist

### Before Creating CLAUDE.md
- [ ] Understand your project's critical workflows
- [ ] Identify commands you type repeatedly
- [ ] Note conventions that aren't obvious from code

### While Writing
- [ ] Keep under 100 lines (ideally < 60)
- [ ] Only universally applicable content
- [ ] Specific, actionable instructions
- [ ] Use imports for detailed docs
- [ ] Reference files, don't copy content
- [ ] **No time estimates anywhere** (use scope/complexity instead)

### After Writing
- [ ] Remove vague instructions
- [ ] Add emphasis to critical rules
- [ ] Test with fresh Claude session
- [ ] Commit to version control

### Weekly Maintenance
- [ ] Remove stale instructions
- [ ] Update changed commands
- [ ] Verify file references
- [ ] Consolidate # additions
- [ ] Review with prompt improver
- [ ] Ensure no time estimates crept in

---

## Summary: The CLAUDE.md Manifesto

1. **Treat CLAUDE.md as code** - Review changes, keep it DRY, refactor regularly
2. **Respect the token budget** - Every line costs context for actual work
3. **Be specific or be ignored** - Vague instructions get deprioritized
4. **Use the hierarchy** - Global → Project → Local → Subdirectory
5. **Progressive disclosure** - Tell Claude where to look, not everything to know
6. **Iterate constantly** - The best CLAUDE.md evolves with your project
7. **Measure effectiveness** - If Claude keeps making the same mistakes, your CLAUDE.md isn't working

---

*This guide synthesizes official Anthropic documentation, community best practices, and research on prompt optimization. Last updated: December 2024.*
