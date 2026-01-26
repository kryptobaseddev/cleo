# Orchestrator: Token Injection System

> Referenced from: @skills/ct-orchestrator/SKILL.md
> Load when: Need details on token injection, placeholder values, manual token setup, or helper functions for template processing

## Token Injection System

The `spawn` command handles token injection automatically. For manual injection, use `lib/token-inject.sh`.

### Automatic (via spawn command)

```bash
# The spawn command automatically:
# 1. Loads the skill template
# 2. Sets required context tokens
# 3. Gets task context from CLEO
# 4. Extracts manifest summaries
# 5. Injects all tokens
cleo orchestrator spawn T1586 --template ct-research-agent
```

### Manual Token Injection

```bash
source lib/token-inject.sh

# 1. Set required tokens
export TI_TASK_ID="T1234"
export TI_DATE="$(date +%Y-%m-%d)"
export TI_TOPIC_SLUG="my-research-topic"

# 2. Set CLEO defaults (task commands, output paths)
ti_set_defaults

# 3. Optional: Get task context from CLEO
task_json=$(cleo show T1234 --format json)
ti_set_task_context "$task_json"

# 4. Load and inject skill template
template=$(ti_load_template "skills/ct-research-agent/SKILL.md")
```

---

## Token Reference

**Source of Truth**: `skills/_shared/placeholders.json`

### Required Tokens

| Token | Description | Pattern | Example |
|-------|-------------|---------|---------|
| `{{TASK_ID}}` | CLEO task identifier | `^T[0-9]+$` | `T1234` |
| `{{DATE}}` | ISO date | `YYYY-MM-DD` | `2026-01-20` |
| `{{TOPIC_SLUG}}` | URL-safe topic name | `[a-zA-Z0-9_-]+` | `auth-research` |

### Task Command Tokens (CLEO defaults)

| Token | Default Value |
|-------|---------------|
| `{{TASK_SHOW_CMD}}` | `cleo show` |
| `{{TASK_FOCUS_CMD}}` | `cleo focus set` |
| `{{TASK_COMPLETE_CMD}}` | `cleo complete` |
| `{{TASK_LINK_CMD}}` | `cleo research link` |
| `{{TASK_LIST_CMD}}` | `cleo list` |
| `{{TASK_FIND_CMD}}` | `cleo find` |
| `{{TASK_ADD_CMD}}` | `cleo add` |

### Output Tokens (CLEO defaults)

| Token | Default Value |
|-------|---------------|
| `{{OUTPUT_DIR}}` | `claudedocs/research-outputs` |
| `{{MANIFEST_PATH}}` | `claudedocs/research-outputs/MANIFEST.jsonl` |

### Task Context Tokens (populated from CLEO task data)

| Token | Source | Description |
|-------|--------|-------------|
| `{{TASK_NAME}}` | `task.title` | Task title |
| `{{TASK_DESCRIPTION}}` | `task.description` | Full description |
| `{{TASK_INSTRUCTIONS}}` | `task.description` | Execution instructions |
| `{{DELIVERABLES_LIST}}` | `task.deliverables` | Expected outputs |
| `{{ACCEPTANCE_CRITERIA}}` | Extracted | Completion criteria |
| `{{DEPENDS_LIST}}` | `task.depends` | Completed dependencies |
| `{{MANIFEST_SUMMARIES}}` | MANIFEST.jsonl | Key findings from previous agents |
| `{{NEXT_TASK_IDS}}` | Dependency analysis | Tasks unblocked after completion |

---

## Helper Functions

| Function | Purpose |
|----------|---------|
| `ti_set_defaults()` | Set CLEO defaults for unset tokens |
| `ti_validate_required()` | Verify required tokens are set |
| `ti_inject_tokens()` | Replace `{{TOKEN}}` patterns |
| `ti_load_template()` | Load file and inject tokens |
| `ti_set_context()` | Set TASK_ID, DATE, TOPIC_SLUG in one call |
| `ti_set_task_context()` | Populate task context tokens from CLEO JSON |
| `ti_extract_manifest_summaries()` | Get key_findings from recent manifest entries |
| `ti_list_tokens()` | Show all tokens with current values |

---

## Token Injection with lib/token-inject.sh

For fine-grained control over token injection, use `lib/token-inject.sh` directly.

### Token Categories

| Category | Tokens | Source |
|----------|--------|--------|
| **Required** | `{{TASK_ID}}`, `{{DATE}}`, `{{TOPIC_SLUG}}` | Must be set before injection |
| **Task Commands** | `{{TASK_SHOW_CMD}}`, `{{TASK_FOCUS_CMD}}`, `{{TASK_COMPLETE_CMD}}`, etc. | CLEO defaults |
| **Output Paths** | `{{OUTPUT_DIR}}`, `{{MANIFEST_PATH}}` | CLEO defaults |
| **Task Context** | `{{TASK_TITLE}}`, `{{TASK_DESCRIPTION}}`, `{{DEPENDS_LIST}}`, etc. | From CLEO task data |
| **Manifest Context** | `{{MANIFEST_SUMMARIES}}` | From recent MANIFEST.jsonl entries |

### Manual Token Injection Example

```bash
source lib/token-inject.sh

# 1. Set required tokens
ti_set_context "T1234" "2026-01-20" "auth-research"

# 2. Set CLEO defaults for task commands and paths
ti_set_defaults

# 3. Get task context from CLEO
task_json=$(cleo show T1234 --format json)
ti_set_task_context "$task_json"

# 4. Load and inject skill template
template=$(ti_load_template "skills/ct-research-agent/SKILL.md")

# 5. Verify tokens were injected
echo "$template" | grep -c '{{' && echo "WARNING: Uninjected tokens remain"
```

### Key Functions

| Function | Purpose | Example |
|----------|---------|---------|
| `ti_set_context()` | Set required tokens | `ti_set_context "T1234" "" "topic"` |
| `ti_set_defaults()` | Set CLEO command defaults | `ti_set_defaults` |
| `ti_set_task_context()` | Populate from CLEO JSON | `ti_set_task_context "$task_json"` |
| `ti_extract_manifest_summaries()` | Get recent findings | `ti_extract_manifest_summaries 5` |
| `ti_load_template()` | Load and inject file | `ti_load_template "path/to/SKILL.md"` |
| `ti_list_tokens()` | Debug token values | `ti_list_tokens` |

---

## Subagent Protocol Tokens

Token defaults (from `skills/_shared/placeholders.json`):
- `{{OUTPUT_DIR}}` -> `claudedocs/research-outputs`
- `{{MANIFEST_PATH}}` -> `claudedocs/research-outputs/MANIFEST.jsonl`

### Inline Protocol Block (when CLI unavailable)

```markdown
## SUBAGENT PROTOCOL (RFC 2119 - MANDATORY)

OUTPUT REQUIREMENTS:
1. MUST write findings to: {{OUTPUT_DIR}}/{{DATE}}_{{TOPIC_SLUG}}.md
2. MUST append ONE line to: {{MANIFEST_PATH}}
3. MUST return ONLY: "Research complete. See MANIFEST.jsonl for summary."
4. MUST NOT return research content in response.

CLEO INTEGRATION:
1. MUST read task details: `{{TASK_SHOW_CMD}} {{TASK_ID}}`
2. MUST set focus: `{{TASK_FOCUS_CMD}} {{TASK_ID}}`
3. MUST complete task when done: `{{TASK_COMPLETE_CMD}} {{TASK_ID}}`
4. SHOULD link research: `{{TASK_LINK_CMD}} {{TASK_ID}} {{RESEARCH_ID}}`  <- RECOMMENDED

**Research Linking Note**: If subagent fails to link research, orchestrator will link on verification.
This ensures bidirectional traceability between tasks and their research artifacts.
```
