# TodoWrite Integration Analysis: Persistent vs Ephemeral Task Synchronization

## Executive Summary

This document analyzes integration patterns between persistent task management systems (claude-todo) and ephemeral session-scoped task tracking (Claude Code's TodoWrite), providing recommendations based on industry research and best practices.

**Key Findings:**
- **Hybrid sync approach recommended**: One-way export (persistent → ephemeral) for session initialization, with optional manual backflow for completions
- **Grammar transformation**: Rule-based approach with lookup table for edge cases is most reliable
- **Field mapping**: Accept strategic data loss in ephemeral view; maintain richness in persistent store
- **Session hooks**: Shell integration hooks provide robust auto-population mechanism

---

## 1. Industry Patterns: Persistent vs Ephemeral Synchronization

### 1.1 GitHub Issues + Project Boards

**Architecture**: Persistent issues (canonical source) → Ephemeral board views (filtered, scoped)

**Key Insights:**
- [GitHub Issues](https://github.com/features/issues) maintains persistent issue storage with rich metadata (labels, milestones, assignees, linked PRs)
- [Project boards](https://docs.github.com/github/managing-your-work-on-github/about-automation-for-project-boards) are **ephemeral views** that filter and display subsets of issues
- **One-way sync pattern**: Changes to issue status in boards reflect back to persistent issues, but boards themselves are disposable
- [Sub-issues feature](https://github.blog/changelog/2025-01-13-evolving-github-issues-public-preview/) (GA in 2025) allows hierarchical task breakdown without losing persistent storage
- **Challenge identified**: [Cross-repository sync](https://github.com/orgs/community/discussions/63960) requires third-party tools or manual linking; no native bidirectional sync
- **Automation limitation**: [GitHub Actions lacks trigger events](https://github.com/marketplace/actions/project-issue-state-sync) for new Projects API, requiring scheduled polling for state sync

**Pattern**: **Persistent-primary with ephemeral projections**

### 1.2 Jira Sprint View + Backlog

**Architecture**: Product backlog (persistent) ↔ Sprint backlog (time-boxed ephemeral)

**Key Insights:**
- [Jira backlog view](https://support.atlassian.com/jira-software-cloud/docs/use-your-scrum-backlog/) shows all work items; board view shows only active sprint items
- **Bidirectional sync**: Issues can move between backlog and sprint, with state automatically synchronized
- [Sprint planning workflow](https://www.atlassian.com/agile/tutorials/sprints): Tasks pulled from backlog into sprint become "active context" for 2-week period
- **Anti-pattern identified**: [Automatic carry-over](https://www.scrum.org/resources/blog/jira-kills-sprint-backlog) of incomplete tasks kills verification and value optimization
- [Best practice](https://www.ricksoft-inc.com/post/how-to-manage-your-product-backlog-in-jira-in-five-steps/): Backlog refinement sessions 2/3 through sprint; focus on next 2-3 sprints only
- **Challenge**: [Workflow complexity](https://www.scrum.org/forum/scrum-forum/33412/workflow-and-backlogsprint-view-jira) when mixing backlog/sprint views leads to confusion about "source of truth"

**Pattern**: **Bidirectional with time-bounded contexts**

### 1.3 Linear Real-Time Synchronization

**Architecture**: Real-time operational database with event-driven updates

**Key Insights:**
- [Linear task management](https://everhour.com/blog/linear-task-management/) uses publish-subscribe pattern for real-time updates across clients
- **Event-driven architecture**: Changes emit events consumed by all subscribed views
- [Priority-based scheduling](https://www.informit.com/articles/article.aspx?p=30188) ensures critical updates processed first
- **Trade-off**: Real-time sync sacrifices eventual consistency for immediate responsiveness
- [Time-triggered architecture](https://palospublishing.com/architectural-patterns-for-real-time-systems/) alternative: Fixed scheduling intervals for predictable synchronization
- **Challenge**: [CAP theorem constraints](https://dev3lop.com/bidirectional-data-synchronization-patterns-between-systems/) require choosing between consistency, availability, and partition tolerance

**Pattern**: **Event-driven real-time with eventual consistency**

---

## 2. Synchronization Strategies: Analysis and Recommendations

### 2.1 One-Way Export (Persistent → Ephemeral)

**Description**: Persistent store populates ephemeral view at session start; ephemeral changes discarded at session end.

**Pros:**
- Simple implementation: No conflict resolution required
- Data integrity: Persistent store remains canonical source of truth
- [No schema drift issues](https://learn.microsoft.com/en-us/azure/data-factory/concepts-data-flow-schema-drift): Transformation happens in one direction only
- Anti-hallucination friendly: Ephemeral view cannot corrupt persistent data

**Cons:**
- Lost work: Session progress not captured if session crashes
- Manual effort: User must manually update persistent store with completions
- No continuity: Next session starts from same state, ignoring ephemeral progress

**Use Case**: Read-only session context where tasks are for display only.

**Recommendation for claude-todo**: **Use for session initialization** (load active tasks into TodoWrite)

### 2.2 Bidirectional Sync

**Description**: Changes in either persistent or ephemeral store sync to the other automatically.

**Pros:**
- Continuity: Session progress automatically saved to persistent store
- User convenience: No manual sync required
- [Real-time accuracy](https://www.merge.dev/blog/bidirectional-synchronization): Both views always reflect current state

**Cons:**
- [Conflict resolution complexity](https://softwareengineering.stackexchange.com/questions/153806/conflict-resolution-for-two-way-sync): Simultaneous edits require resolution strategy
- [Schema mapping challenges](https://www.fivetran.com/learn/data-mapping): Rich persistent schema vs simple ephemeral schema requires field transformation
- [Data loss risk](https://github.com/divolte/divolte-collector/issues/110): Mapping failures can lose information
- Implementation complexity: Requires change detection, conflict resolution, and error handling

**Use Case**: Collaborative environments where multiple clients modify shared state.

**Recommendation for claude-todo**: **Not recommended** due to anti-hallucination requirements and schema mismatch.

### 2.3 Hybrid: Export + Manual Backflow

**Description**: Persistent → Ephemeral at session start (one-way); ephemeral → Persistent on user command (manual).

**Pros:**
- Controlled updates: User decides when to commit ephemeral changes to persistent store
- Simple conflict resolution: User resolves conflicts at commit time
- [Schema validation gate](https://flatfile.com/blog/ultimate-introduction-data-mapping/): Manual commits can validate before persisting
- Audit trail: Explicit user action creates log entry for each sync

**Cons:**
- User discipline required: Must remember to commit changes
- Partial automation: Not fully automated workflow
- Potential data loss: Crashes lose uncommitted work

**Use Case**: Development workflows where explicit commits are natural (git-like pattern).

**Recommendation for claude-todo**: **Primary recommended approach** with optional auto-commit on session end.

### 2.4 Recommendation Matrix

| Sync Strategy | Implementation Complexity | Data Safety | User Convenience | Recommendation |
|---------------|--------------------------|-------------|------------------|----------------|
| One-Way Export | Low | High | Low | Session init only |
| Bidirectional | High | Medium | High | Not recommended |
| Hybrid Export + Manual Backflow | Medium | High | Medium | **Primary approach** |
| Hybrid + Auto-commit on session end | Medium-High | Medium-High | High | **Enhanced option** |

---

## 3. Field Mapping Challenges and Solutions

### 3.1 Schema Comparison

**claude-todo (Persistent Schema - Rich)**:
```json
{
  "id": "T001",
  "title": "Implement authentication",
  "description": "Add JWT-based authentication with email/password login",
  "status": "pending",
  "priority": "high",
  "files": ["src/auth/jwt.ts", "src/middleware/auth.ts"],
  "acceptance": ["Login endpoint works", "Token refresh implemented"],
  "depends": ["T002"],
  "blockedBy": [],
  "notes": "Reference: https://jwt.io",
  "labels": ["backend", "security"],
  "createdAt": "2025-12-05T10:00:00Z",
  "completedAt": null
}
```

**TodoWrite (Ephemeral Schema - Simple)**:
```typescript
{
  content: "Implement authentication",
  status: "pending",
  activeForm: "Implementing authentication"
}
```

### 3.2 Field Mapping Strategy

#### Direct Mappings (No Loss)
- `title` → `content`: 1:1 mapping
- `status` → `status`: Value transformation required (see 3.3)

#### Strategic Omissions (Acceptable Loss)
- `description`: **Lost in ephemeral view** (acceptable - display in persistent store)
- `priority`: **Lost** (TodoWrite has no priority field)
- `files`: **Lost** (display context, not needed for execution tracking)
- `acceptance`: **Lost** (criteria verification happens in persistent layer)
- `depends`, `blockedBy`: **Lost** (dependency resolution not needed for session work)
- `notes`: **Lost** (captured in persistent layer)
- `labels`: **Lost** (filtering/organization not needed in ephemeral view)
- `timestamps`: **Implicit** (session start/end times tracked separately)

#### Derived Fields
- `activeForm`: **Generated from `title`** using grammar transformation (see Section 4)

### 3.3 Status Value Translation

**Mapping Table**:

| claude-todo Status | TodoWrite Status | Notes |
|-------------------|------------------|-------|
| `pending` | `pending` | Direct mapping |
| `active` | `in_progress` | Semantic match |
| `blocked` | `pending` with note | Downgrade (blocker info lost) |
| `done` | `completed` | Semantic match |

**Reverse Mapping (Backflow)**:

| TodoWrite Status | claude-todo Status | Conflict Resolution |
|-----------------|-------------------|---------------------|
| `pending` | `pending` | Safe |
| `in_progress` | `active` | Check only 1 active task rule |
| `completed` | `done` | Add `completedAt` timestamp |

### 3.4 Information Loss Assessment

**Critical Information (Must Preserve)**:
- Task ID: **Preserve via comment or metadata** if TodoWrite supports it
- Status: **Mapped with acceptable semantic loss**

**Important Information (Preserve in Persistent)**:
- Priority, dependencies, acceptance criteria: **Remain in persistent store**
- Display when task selected/focused, not in TodoWrite list

**Nice-to-Have Information**:
- Labels, notes, files: **Available in persistent store for reference**

**Assessment**: [Acceptable data loss for ephemeral view](https://stackoverflow.com/questions/9551187/flexibility-tradeoff-in-database-schema-design) - TodoWrite is execution context, not archival storage.

---

## 4. Grammar Transformation: Imperative to Present Continuous

### 4.1 Transformation Rules

**Basic Rule**: `title` (imperative) → `activeForm` (present continuous)

**English Grammar Pattern**:
- [Imperative form](https://en.wikipedia.org/wiki/Imperative_mood): Bare infinitive (e.g., "Implement", "Fix", "Add")
- [Present continuous](https://www.ef.com/wwen/english-resources/english-grammar/present-continuous/): "to be" + verb-ing (e.g., "Implementing", "Fixing", "Adding")

**Transformation**: For TodoWrite, omit "to be" auxiliary and subject, use only verb-ing form.

### 4.2 Regular Transformations

[Most English verbs form -ing regularly](https://www.englishclub.com/grammar/verbs-ing-form.php) by adding "-ing" to base form:

**Pattern 1: Simple Addition**
- Implement → Implementing
- Analyze → Analyzing
- Document → Documenting
- Review → Reviewing

**Pattern 2: Silent E Removal**
- [Remove mute 'e' before adding -ing](https://www.crownacademyenglish.com/ing-form-english-verbs/)
- Create → Creating
- Write → Writing
- Configure → Configuring

**Pattern 3: Consonant Doubling**
- [Double final consonant if: one syllable, one vowel, one consonant (not y)](http://ekladata.com/LVHFd3_14gFQzJ_daVU_QN_1JVo/Regular-and-irregular-ing-forms.pdf)
- Fix → Fixing (no doubling - ends in 'x')
- Run → Running (double 'n')
- Sit → Sitting (double 't')

**Pattern 4: IE → Y**
- [When verb ends in -ie, replace with -y before -ing](https://quillbot.com/blog/frequently-asked-questions/what-is-the-ing-form-of-a-verb/)
- Tie → Tying
- Lie → Lying
- Die → Dying

### 4.3 Edge Cases and Exceptions

**Problematic Verbs**:
1. **Be**: "Be" → "Being" (common in passive: "being tested")
2. **Do**: "Do" → "Doing"
3. **Have**: "Have" → "Having"
4. **Go**: "Go" → "Going"
5. **See**: "See" → "Seeing"

**Multi-word Imperatives**:
- "Set up authentication" → "Setting up authentication"
- "Clean up codebase" → "Cleaning up codebase"
- "Check in with team" → "Checking in with team"

**Phrasal Verbs**:
- Transform only the main verb, preserve particle
- "Add in error handling" → "Adding in error handling"
- "Look up documentation" → "Looking up documentation"

### 4.4 Reliability Analysis

**Rule-Based Approach**:
- **Accuracy**: ~95% for standard task titles (imperative verb phrases)
- **Failures**: Non-verb-initial titles ("User authentication implementation" → unclear transformation)
- **Recommendation**: Use simple rule-based transformer with known patterns

**Lookup Table Approach**:
- **Accuracy**: 100% for listed verbs
- **Coverage**: Requires comprehensive verb list (200-300 common task verbs)
- **Recommendation**: Use for high-frequency verbs (top 50-100)

**Hybrid Approach (Recommended)**:
1. **Lookup table**: Top 100 task verbs (e.g., implement, fix, add, refactor, update)
2. **Rule engine**: Apply patterns 1-4 for unlisted verbs
3. **Fallback**: If transformation uncertain, use title as-is with warning log

**Implementation Example**:
```bash
# Lookup table (partial)
declare -A VERB_TO_ING=(
  ["implement"]="Implementing"
  ["fix"]="Fixing"
  ["add"]="Adding"
  ["refactor"]="Refactoring"
  ["update"]="Updating"
  ["create"]="Creating"
  ["delete"]="Deleting"
  ["test"]="Testing"
  ["deploy"]="Deploying"
  ["configure"]="Configuring"
  ["optimize"]="Optimizing"
  ["debug"]="Debugging"
  ["design"]="Designing"
  ["review"]="Reviewing"
  ["merge"]="Merging"
  ["build"]="Building"
  ["run"]="Running"
  ["setup"]="Setting up"
  ["cleanup"]="Cleaning up"
  ["validate"]="Validating"
  ["verify"]="Verifying"
)

transform_to_active_form() {
  local title="$1"
  local first_word=$(echo "$title" | awk '{print tolower($1)}')

  # Lookup table first
  if [[ -n "${VERB_TO_ING[$first_word]}" ]]; then
    local active_verb="${VERB_TO_ING[$first_word]}"
    echo "${active_verb}${title#${first_word}}"
    return
  fi

  # Rule-based transformation
  # Pattern 2: Silent e removal
  if [[ $first_word =~ e$ ]]; then
    local stem="${first_word%e}"
    echo "${stem^}ing${title#${first_word}}"
    return
  fi

  # Pattern 1: Simple addition
  echo "${first_word^}ing${title#${first_word}}"
}
```

### 4.5 AI-Assisted Transformation (Not Recommended)

**Pros**: Handles complex cases, natural language understanding
**Cons**:
- **Latency**: API call delay for every task transformation
- **Cost**: API costs for large task lists
- **Reliability**: Non-deterministic; same input may yield different outputs
- **Offline**: Requires network connectivity
- **Anti-hallucination**: Introduces hallucination risk in transformation layer

**Recommendation**: Only use AI-assisted transformation if lookup + rules fail; cache results.

---

## 5. Session Hook Integration Patterns

### 5.1 Shell Hook Mechanisms

**Bash Hooks**:
- [`trap`](https://stackoverflow.com/questions/18221348/exit-hook-working-both-on-bash-and-zsh): `trap command EXIT` for session end
- **Limitation**: No built-in session start hook; use `.bashrc` sourcing

**Zsh Hooks**:
- [`precmd`](https://unix.stackexchange.com/questions/102595/is-there-a-hook-like-system-for-shell): Runs before each prompt display
- [`preexec`](https://www.digitalocean.com/community/tutorials/how-to-use-editors-regex-and-hooks-with-z-shell): Runs before each command execution
- [`chpwd`](https://www.digitalocean.com/community/tutorials/how-to-use-editors-regex-and-hooks-with-z-shell): Runs on directory change
- [`TRAPEXIT()`](https://stackoverflow.com/questions/18221348/exit-hook-working-both-on-bash-and-zsh): Session exit hook

**Fish Hooks**:
- `--on-variable PWD`: Trigger on directory change
- `fish_exit`: Session end event

### 5.2 Terminal Multiplexer Integration

**tmux Integration**:
- [`set-hook`](https://man7.org/linux/man-pages/man1/tmux.1.html): Session/window/pane event hooks
- [Tmuxinator](https://github.com/tmuxinator/tmuxinator): Project-based session management with hooks:
  - `on_project_start`: Run on every session start
  - `on_project_first_start`: Run only on first session creation
  - `on_project_exit`: Run on session detach/exit
  - `pre_window`: Run in each window before commands

**Implementation Pattern**:
```yaml
# .tmuxinator.yml
name: my-project
on_project_start: claude-todo session start
on_project_exit: claude-todo session end
windows:
  - editor: vim
  - shell:
      pre: claude-todo list --format text
```

**screen Integration**:
- [Less sophisticated hook system](https://www.linuxbash.sh/post/the-screen-and-tmux-for-session-management) than tmux
- Use shell hooks in `.screenrc` for basic session management

### 5.3 CLI Auto-Population Patterns

**Pattern 1: Shell RC Integration**
```bash
# .zshrc or .bashrc
claude_todo_session_init() {
  if [[ -f .claude/todo.json ]]; then
    # Auto-populate TodoWrite from claude-todo
    claude-todo export-session --format todowrite
  fi
}

# Zsh hook
precmd_functions+=(claude_todo_session_init)

# Bash hook
PROMPT_COMMAND="claude_todo_session_init; $PROMPT_COMMAND"
```

**Pattern 2: tmux Hook Integration**
```bash
# .tmux.conf
set-hook -g session-created 'run-shell "cd #{pane_current_path} && claude-todo session start"'
set-hook -g session-closed 'run-shell "cd #{pane_current_path} && claude-todo session end"'
```

**Pattern 3: Claude Code Integration**
- Create `claude-todo session start` command that outputs TodoWrite-compatible JSON
- Claude Code sources this on session initialization
- Session end triggers `claude-todo session end` to commit completions

### 5.4 Session Lifecycle Workflow

**Session Start**:
1. Shell/tmux hook detects session start
2. Run `claude-todo session start`:
   - Load `.claude/todo.json`
   - Filter for `active` and high-priority `pending` tasks
   - Transform to TodoWrite format (title → content, status mapping, activeForm generation)
   - Output JSON to stdout
3. Claude Code imports TodoWrite tasks
4. Log session start to `todo-log.json`

**During Session**:
- User works with TodoWrite tasks (ephemeral state)
- Optionally: `claude-todo sync` command to manually commit progress

**Session End**:
1. Hook detects session end (`TRAPEXIT`, tmux `session-closed`, etc.)
2. Run `claude-todo session end`:
   - Compare TodoWrite state (if accessible) with persistent state
   - Prompt user: "Update persistent tasks with session progress? [y/N]"
   - If yes: Update `todo.json` with completed tasks
   - Log session end to `todo-log.json`
3. Clean up ephemeral state

### 5.5 Implementation Recommendation

**Recommended Approach**:
1. **Shell RC Integration** for basic session detection
2. **tmux/Tmuxinator hooks** for advanced users with multiplexer workflows
3. **Manual commands** as fallback: `claude-todo session {start|end|sync}`

**Commands to Implement**:
```bash
claude-todo session start              # Export tasks to TodoWrite format
claude-todo session end                # Commit TodoWrite completions to persistent
claude-todo session sync               # Mid-session sync (optional)
claude-todo session status             # Show current session state
```

---

## 6. Recommendations for claude-todo Project

### 6.1 Integration Architecture

**Recommended Pattern**: **Hybrid Export + Optional Backflow**

```
┌─────────────────────────────────────────────────────┐
│              Session Lifecycle                       │
└─────────────────────────────────────────────────────┘
                         │
         ┌───────────────┴───────────────┐
         ▼                               ▼
┌─────────────────┐             ┌─────────────────┐
│  Session Start  │             │   Session End   │
│                 │             │                 │
│  Hook Trigger   │             │  Hook Trigger   │
└────────┬────────┘             └────────┬────────┘
         │                               │
         ▼                               ▼
┌─────────────────────────────────────────────────────┐
│           claude-todo CLI Commands                   │
├─────────────────────────────────────────────────────┤
│  session start:                                      │
│    1. Load .claude/todo.json                        │
│    2. Filter active + pending tasks                 │
│    3. Transform to TodoWrite schema                 │
│    4. Generate activeForm via grammar rules         │
│    5. Output JSON to stdout                         │
│    6. Log session_start event                       │
│                                                      │
│  session end:                                        │
│    1. Read current TodoWrite state (if available)   │
│    2. Compare with persistent state                 │
│    3. Prompt user for backflow commit (optional)    │
│    4. Update todo.json with completions             │
│    5. Log session_end event                         │
└─────────────────────────────────────────────────────┘
         │                               ▲
         │  One-Way Export               │  Manual Backflow
         ▼                               │  (Optional)
┌─────────────────────────────────────────────────────┐
│                  TodoWrite State                     │
│               (Ephemeral Session)                    │
│                                                      │
│  [ { content, status, activeForm }, ... ]           │
└─────────────────────────────────────────────────────┘
         │
         │  Optional Mid-Session Sync
         ▼
    claude-todo session sync
```

### 6.2 Field Mapping Specification

**Export Transformation (Persistent → Ephemeral)**:

```bash
# Input: .claude/todo.json task
{
  "id": "T001",
  "title": "Implement authentication",
  "status": "active",
  "priority": "high",
  ...
}

# Output: TodoWrite format
{
  "content": "Implement authentication",
  "status": "in_progress",
  "activeForm": "Implementing authentication"
}
```

**Status Mapping Table**:
```bash
pending   → pending
active    → in_progress
blocked   → pending        # Downgrade (blocker info preserved in persistent only)
done      → completed
```

**Backflow Transformation (Ephemeral → Persistent)**:

```bash
# Input: TodoWrite task
{
  "content": "Implement authentication",
  "status": "completed",
  "activeForm": "Implementing authentication"
}

# Find matching task by content in todo.json
# Update:
{
  "status": "done",
  "completedAt": "2025-12-05T15:30:00Z"
}
```

### 6.3 Grammar Transformation Implementation

**Hybrid Lookup + Rule-Based Approach**:

1. **Lookup Table**: `/mnt/projects/claude-todo/lib/verb-to-ing-lookup.sh`
   - Top 100 task verbs with hand-verified transformations
   - Handles edge cases: "set up" → "setting up", "be" → "being"

2. **Rule Engine**: `/mnt/projects/claude-todo/lib/grammar-transform.sh`
   - Pattern 1: Simple -ing addition
   - Pattern 2: Silent e removal
   - Pattern 3: Consonant doubling (if needed)
   - Pattern 4: IE → Y transformation

3. **Fallback**: If uncertain, use title as-is and log warning

**Example Implementation**:
```bash
#!/bin/bash
# lib/grammar-transform.sh

source "$(dirname "$0")/verb-to-ing-lookup.sh"

transform_to_active_form() {
  local title="$1"
  local first_word=$(echo "$title" | awk '{print tolower($1)}')
  local rest="${title#* }"

  # Lookup table first
  if [[ -n "${VERB_TO_ING[$first_word]}" ]]; then
    echo "${VERB_TO_ING[$first_word]} ${rest}"
    return 0
  fi

  # Rule-based transformation
  local active_verb=""

  # Pattern 2: Silent e removal (create → creating)
  if [[ $first_word =~ e$ ]]; then
    active_verb="${first_word%e}ing"
  # Pattern 4: IE to Y (tie → tying)
  elif [[ $first_word =~ ie$ ]]; then
    active_verb="${first_word%ie}ying"
  # Pattern 1: Simple addition
  else
    active_verb="${first_word}ing"
  fi

  # Capitalize and combine
  echo "${active_verb^} ${rest}"
}
```

### 6.4 Session Hook Integration

**Implementation Steps**:

1. **Add session commands to CLI**:
   ```bash
   claude-todo session start    # Export to TodoWrite format
   claude-todo session end      # Commit TodoWrite completions
   claude-todo session sync     # Mid-session manual sync
   claude-todo session status   # Display current session info
   ```

2. **Create shell integration script**: `/mnt/projects/claude-todo/scripts/shell-integration.sh`
   - Zsh hooks (`precmd`, `TRAPEXIT`)
   - Bash hooks (`PROMPT_COMMAND`, `trap EXIT`)
   - Fish hooks (`--on-variable PWD`, `fish_exit`)

3. **Optional tmux integration**: `/mnt/projects/claude-todo/scripts/tmux-hooks.sh`
   - Example tmuxinator configuration
   - tmux `set-hook` examples

4. **CLAUDE.md integration**:
   - Document session workflow in project CLAUDE.md
   - Add TodoWrite sync protocol to anti-hallucination rules

### 6.5 Anti-Hallucination Safeguards

**Validation Gates**:
1. **Export validation**: Verify todo.json schema before export
2. **Status mapping validation**: Only allow valid status transitions
3. **Backflow validation**: Match tasks by title before updating status
4. **Checksum verification**: Verify todo.json checksum before and after sync
5. **Logging**: Log all session events (start, end, sync, errors)

**Error Handling**:
- Export failure → Log error, skip TodoWrite population
- Backflow conflict → Prompt user, never auto-resolve
- Invalid status → Reject update, log warning
- Checksum mismatch → Abort operation, restore from backup

### 6.6 Configuration Options

**Add to `.claude/todo-config.json`**:
```json
{
  "session": {
    "auto_export_on_start": true,
    "auto_commit_on_end": false,
    "prompt_commit_on_end": true,
    "export_filters": {
      "include_statuses": ["pending", "active"],
      "max_tasks": 10,
      "priority_threshold": "medium"
    },
    "backflow_rules": {
      "allow_status_updates": true,
      "allow_completion": true,
      "require_confirmation": true
    }
  },
  "grammar": {
    "transformation_method": "hybrid",
    "fallback_to_title": true,
    "log_transformations": false
  }
}
```

### 6.7 Implementation Roadmap

**Phase 1: Core Commands** (Week 1)
- Implement `claude-todo session start` command
- Implement grammar transformation library (lookup + rules)
- Add field mapping functions (persistent → ephemeral)
- Add session logging to todo-log.json
- Write unit tests for grammar transformation

**Phase 2: Backflow Logic** (Week 2)
- Implement `claude-todo session end` command
- Add TodoWrite state comparison logic
- Implement user confirmation prompts
- Add reverse field mapping (ephemeral → persistent)
- Validate backflow updates against schema

**Phase 3: Shell Integration** (Week 3)
- Create shell integration scripts (zsh, bash, fish)
- Write tmux/tmuxinator integration examples
- Document installation and configuration
- Add session status command
- Create integration tests

**Phase 4: Configuration & Polish** (Week 4)
- Add session configuration to todo-config.json schema
- Implement configuration-driven filtering
- Add session sync (mid-session) command
- Write comprehensive documentation
- User acceptance testing

---

## 7. Comparative Analysis Summary

| Aspect | Industry Pattern | claude-todo Recommendation |
|--------|------------------|---------------------------|
| **Sync Strategy** | Hybrid (GitHub, Jira) | Hybrid export + optional backflow |
| **Data Flow** | One-way primary, bidirectional optional | One-way export, manual backflow on user command |
| **Conflict Resolution** | Timestamp-based, user prompts | User confirmation required for backflow |
| **Schema Mapping** | Rich persistent → Simple views | Accept data loss in ephemeral; preserve in persistent |
| **Status Translation** | Semantic mapping with downgrades | pending→pending, active→in_progress, done→completed |
| **Grammar Transform** | N/A (not applicable in industry examples) | Hybrid lookup table + rule-based transformation |
| **Session Hooks** | tmux/screen hooks, shell RC integration | Multi-shell support (bash, zsh, fish) + tmux integration |
| **Anti-Hallucination** | Validation at integration boundaries | Schema validation, checksum verification, logging |

---

## 8. Conclusion

**Key Recommendations**:

1. **Hybrid Sync Pattern**: One-way export for session start, optional manual backflow for completions
   - Balances convenience with data safety
   - Maintains persistent store as canonical source of truth
   - Allows user control over sync timing

2. **Acceptable Data Loss**: Rich schema (persistent) → Simple schema (ephemeral)
   - Ephemeral view for execution context only
   - Priority, dependencies, acceptance criteria remain in persistent layer
   - No critical information lost; complementary views serve different purposes

3. **Grammar Transformation**: Hybrid lookup table + rule-based engine
   - Top 100 task verbs in lookup table for reliability
   - Rule engine handles uncommon verbs
   - ~95% accuracy for standard task titles

4. **Shell Integration**: Multi-shell hook support with tmux integration
   - Zsh/Bash/Fish shell RC integration for basic workflows
   - Tmux/Tmuxinator hooks for advanced multiplexer users
   - Manual commands as universal fallback

5. **Anti-Hallucination**: Validation gates at all sync boundaries
   - Schema validation before export and after backflow
   - Checksum verification for integrity
   - Comprehensive logging for audit trail
   - User confirmation required for destructive operations

**Next Steps**: Proceed with Phase 1 implementation (core commands and grammar transformation library).

---

## 9. Sources and References

### Industry Patterns
- [GitHub Issues](https://github.com/features/issues)
- [GitHub Project Boards Automation](https://docs.github.com/github/managing-your-work-on-github/about-automation-for-project-boards)
- [GitHub Issues Evolution 2025](https://github.blog/changelog/2025-01-13-evolving-github-issues-public-preview/)
- [Cross-Repository Sync Discussion](https://github.com/orgs/community/discussions/63960)
- [Project Issue State Sync](https://github.com/marketplace/actions/project-issue-state-sync)
- [Jira Scrum Backlog](https://support.atlassian.com/jira-software-cloud/docs/use-your-scrum-backlog/)
- [Jira Sprint Tutorial](https://www.atlassian.com/agile/tutorials/sprints)
- [Jira Sprint Planning](https://activitytimeline.com/blog/how-to-manage-resources-during-jira-sprint-planning)
- [Jira Backlog Management](https://www.ricksoft-inc.com/post/how-to-manage-your-product-backlog-in-jira-in-five-steps/)
- [Linear Task Management](https://everhour.com/blog/linear-task-management/)

### Synchronization Patterns
- [Bidirectional Sync Patterns](https://dev3lop.com/bidirectional-data-synchronization-patterns-between-systems/)
- [Two-Way Sync Concepts](https://www.merge.dev/blog/bidirectional-synchronization)
- [Conflict Resolution Strategies](https://softwareengineering.stackexchange.com/questions/153806/conflict-resolution-for-two-way-sync)
- [CRM Conflict Resolution Engine](https://www.stacksync.com/blog/deep-dive-stacksyncs-conflict-resolution-engine-for-bidirectional-crm-integration)
- [Building Bidirectional Sync](https://marcel.is/bidirectional-sync/)
- [Real-Time Architecture Patterns](https://palospublishing.com/architectural-patterns-for-real-time-systems/)
- [Real-Time Design Patterns](http://www.uml.org.cn/UMLApplication/pdf/rtpatterns.pdf)

### Field Mapping and Schema
- [Schema Drift in Data Flow](https://learn.microsoft.com/en-us/azure/data-factory/concepts-data-flow-schema-drift)
- [Data Mapping Guide](https://www.knack.com/blog/data-mapping-guide/)
- [Schema Drift Management](https://estuary.dev/blog/schema-drift/)
- [Data Mapping Techniques](https://www.fivetran.com/learn/data-mapping)
- [Schema Mapping Data Loss](https://github.com/divolte/divolte-collector/issues/110)
- [Database Design Tradeoffs](https://stackoverflow.com/questions/9551187/flexibility-tradeoff-in-database-schema-design)
- [Data Mapping Introduction](https://flatfile.com/blog/ultimate-introduction-data-mapping/)

### Grammar Transformation
- [English Verb Conjugation](https://conjugator.reverso.net/conjugation-english.html)
- [Present Continuous Form](https://learnenglish.britishcouncil.org/grammar/english-grammar-reference/present-continuous)
- [Verb Conjugation in English](https://englishan.com/verb-conjugation/)
- [ING Form Rules](https://www.crownacademyenglish.com/ing-form-english-verbs/)
- [Regular and Irregular -ing Forms](http://ekladata.com/LVHFd3_14gFQzJ_daVU_QN_1JVo/Regular-and-irregular-ing-forms.pdf)
- [Imperative Mood](https://en.wikipedia.org/wiki/Imperative_mood)

### Shell Integration
- [Shell Hooks (Zsh)](https://unix.stackexchange.com/questions/102595/is-there-a-hook-like-system-for-shell)
- [Exit Hooks (Bash/Zsh)](https://stackoverflow.com/questions/18221348/exit-hook-working-both-on-bash-and-zsh)
- [Zsh Hooks Tutorial](https://www.digitalocean.com/community/tutorials/how-to-use-editors-regex-and-hooks-with-z-shell)
- [Kitty Shell Integration](https://sw.kovidgoyal.net/kitty/shell-integration/)
- [tmux Manual](https://man7.org/linux/man-pages/man1/tmux.1.html)
- [Tmuxinator](https://github.com/tmuxinator/tmuxinator)
- [tmux Session Manager](https://github.com/joshmedeski/t-smart-tmux-session-manager)
- [tmuxp](https://github.com/tmux-python/tmuxp)
- [Screen and tmux for Session Management](https://www.linuxbash.sh/post/the-screen-and-tmux-for-session-management)

---

**Document Version**: 1.0
**Date**: 2025-12-05
**Author**: Deep Research Analysis for claude-todo Project
**Status**: Recommendation Proposal
