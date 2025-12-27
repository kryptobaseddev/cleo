<!-- CLEO:START v0.38.0 -->
## Task Management (cleo)

Use `ct` (alias for `cleo`) for all task operations. Full docs: `~/.cleo/docs/TODO_Task_Management.md`

### ALWAYS USE Data Integrity
- **JSON auto-detection**: Piped output → JSON (no `--format` needed)
- **Native filters**: Use `--status`, `--label`, `--phase` instead of jq
- **Context-efficient**: Prefer `find` over `list` for task discovery
- **Command discovery**: `ct commands -r critical` (no jq needed)
- **CLI only** - NEVER edit `.cleo/*.json` directly
- **Verify state** - Use `cleo list` before assuming
- **Session discipline** - ALWAYS Start/end sessions properly

### Essential Commands
```bash
ct list                    # View tasks (JSON when piped)
ct find "query"            # Fuzzy search (99% less context than list)
ct add "Task"              # Create task
ct done <id>               # Complete task
ct focus set <id>          # Set active task
ct focus show              # Show current focus
ct session start|end       # Session lifecycle
ct exists <id>             # Verify task exists
ct dash                    # Project overview
ct analyze                 # Task triage (JSON default)
ct analyze --auto-focus    # Auto-set focus to top task
ct delete <id> --reason "..."  # Cancel/soft-delete task
ct uncancel <id>           # Restore cancelled task
```

### Command Discovery
```bash
cleo commands -r critical    # Show critical commands (no jq needed)
```

### MUST use Session Protocol
```bash
cleo session start           # Start work session
cleo session end             # End work session
```

### Phase Tracking
```bash
ct phases                  # List phases with progress
ct phase set <slug>        # Set current project phase
ct phase show              # Show current phase
ct list --phase core       # Filter tasks by phase
```
### Phase Integration
- Tasks can be assigned to project phases
- Phases provide progress tracking and organization
- Use `cleo list --phase <slug>` to filter by phase

### Phase Discipline
**Check phase context before work:**
```bash
ct phase show              # Always verify current phase
ct list --phase $(ct phase show -q)  # Focus on current phase tasks
```

**Cross-phase work guidelines:**
- **Same phase preferred** - Work within current phase when possible
- **Intentional cross-phase** - Document rationale when working across phases
- **Phase-aware creation** - Set task phase during creation: `ct add "Task" --phase testing`

**Phase progression awareness:**
- Core phase: Feature development and main implementation
- Testing phase: Validation, testing, and quality assurance
- Polish phase: Refinement, documentation, and final touches
- Maintenance phase: Bug fixes and ongoing support

### Hierarchy Automation (v0.24.0+)
- **Auto-complete**: Parent completes when all children done (if enabled)
- **Orphan repair**: `ct validate --fix-orphans unlink`
- **Tree view**: `ct tree` or `ct list --tree` (equivalent). Subtree: `ct tree --parent T001`
- **Reparent**: `ct reparent T005 --to T001` (move to different parent)
- **Promote**: `ct promote T005` (remove parent, make root)
- **Populate hierarchy**: `ct populate-hierarchy` (infer parentId from naming conventions)

**Enable auto-complete:**
```bash
ct config set hierarchy.autoCompleteParent true
ct config set hierarchy.autoCompleteMode auto  # auto|suggest|off
```

**Move tasks in hierarchy:**
```bash
ct reparent T005 --to T001           # Move T005 under T001
ct reparent T005 --to ""             # Remove parent (make root)
ct promote T005                      # Same as reparent --to ""
```

**Detect and fix orphaned tasks:**
```bash
ct validate --check-orphans          # Check for orphans
ct validate --fix-orphans unlink     # Remove invalid parent references
ct validate --fix-orphans delete     # Delete orphaned tasks
```

### Data Integrity
- **CLI only** - Never edit `.cleo/*.json` directly
- **Verify state** - Use `ct list` before assuming
- **Session discipline** - Start/end sessions properly
<!-- CLEO:END -->
