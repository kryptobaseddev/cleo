# Orchestrator Protocol Templates

Reusable templates for the CLEO Orchestrator Protocol.

## Quick Start

### 1. Enable Protocol (Skill-Based - Recommended)

```bash
# Option A: On-demand activation
# Say "activate orchestrator mode" or use Skill tool

# Option B: Install to project for persistent availability
cleo orchestrator skill --install
```

### 2. Initialize Research Directory

```bash
cleo research init
```

### 3. Start Orchestrating

```bash
cleo orchestrator start --epic T001
cleo orchestrator spawn T002
```

## Activation Methods

| Method | When to Use | How |
|--------|-------------|-----|
| Skill (recommended) | Most workflows | `Skill: orchestrator` or natural language |
| CLI install | Persistent project setup | `cleo orchestrator skill --install` |
| CLAUDE.md injection | **DEPRECATED** | Do not use |

**Why skill-based?** See [migration notes](#legacy-claudemd-injection-deprecated) below.

## Directory Structure

```
orchestrator-protocol/
  README.md                  # This file
  PLACEHOLDER-REGISTRY.md    # Template placeholder definitions

skills/                      # Skill definitions (migrated from subagent-prompts/)
  _shared/                   # Shared references for all skills
  spec-writer/SKILL.md       # Specification writing
  epic-architect/SKILL.md    # Epic planning and decomposition
  test-writer-bats/SKILL.md  # BATS test writing
  library-implementer-bash/SKILL.md  # Bash library implementation
  research-agent/SKILL.md    # Research and investigation
  task-executor/SKILL.md     # General task execution
  validator/SKILL.md         # Testing and validation
```

**Archived**: `docs/archive/ORCHESTRATOR-INJECT.md` (deprecated CLAUDE.md injection)

## Skills (Migrated)

Skills have replaced subagent prompt templates. Each skill is self-contained with:
- `SKILL.md` - Main skill definition with frontmatter
- `references/` - Optional supporting documentation
- `examples/` - Optional usage examples

| Skill | Use Case | Location |
|-------|----------|----------|
| spec-writer | Specification writing | `skills/spec-writer/` |
| epic-architect | Epic planning | `skills/epic-architect/` |
| test-writer-bats | BATS test writing | `skills/test-writer-bats/` |
| library-implementer-bash | Bash library implementation | `skills/library-implementer-bash/` |
| research-agent | Research tasks | `skills/research-agent/` |
| task-executor | General task work | `skills/task-executor/` |
| validator | Testing/validation | `skills/validator/` |

### Placeholders

Templates use `{PLACEHOLDER}` syntax:

| Placeholder | Description |
|-------------|-------------|
| `{TASK_ID}` | CLEO task ID (e.g., T1586) |
| `{TASK_TITLE}` | Task title |
| `{TASK_NAME}` | Slugified task name |
| `{EPIC_ID}` | Parent epic ID |
| `{EPIC_TITLE}` | Parent epic title |
| `{SESSION_ID}` | Current session ID |
| `{DATE}` | Today's date (YYYY-MM-DD) |
| `{OUTPUT_DIR}` | Research output directory |
| `{TOPIC_SLUG}` | Slugified topic name |
| `{DEPENDS_LIST}` | Comma-separated dependencies |
| `{MANIFEST_SUMMARIES}` | Key findings from prior agents |
| `{TASK_INSTRUCTIONS}` | Task description |

## Usage

### CLI (Recommended)

```bash
# Auto-fills all placeholders
cleo orchestrator spawn T1586

# With specific template
cleo orchestrator spawn T1586 --template RESEARCH-AGENT
```

### Manual

1. Read skill:
```bash
cat skills/task-executor/SKILL.md
```

2. Replace placeholders manually

3. Spawn via Task tool

## Customization

### Add New Skill

1. Create directory under `skills/`
2. Add `SKILL.md` with YAML frontmatter
3. Add `references/` for supporting docs
4. Use standard placeholders

### Modify Existing

Edit skills in `skills/<skill-name>/`. Changes take effect on next spawn.

## Legacy: CLAUDE.md Injection (DEPRECATED)

> **Do NOT use CLAUDE.md injection for the orchestrator protocol.**

**Why deprecated?**

CLAUDE.md injection affects ALL agents including subagents, breaking the orchestrator pattern:

| Problem | Impact |
|---------|--------|
| Subagents read CLAUDE.md | They also try to orchestrate |
| Context overhead | Orchestrator rules loaded in every agent |
| Role confusion | Workers try to delegate instead of execute |
| Protocol violations | Nested orchestration breaks dependency tracking |

**Migration steps:**

1. Remove any `<!-- ORCHESTRATOR:START -->` blocks from your CLAUDE.md
2. Run: `cleo orchestrator skill --install`
3. Activate skill when orchestrator mode is needed

## Documentation

- [Orchestrator Protocol Guide](../../docs/guides/ORCHESTRATOR-PROTOCOL.md)
- [CLI Reference](../../docs/commands/orchestrator.md)
- [Example Session](../../docs/examples/orchestrator-example-session.md)
- [Skill Directory](../../skills/orchestrator/README.md)
