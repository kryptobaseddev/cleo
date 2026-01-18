# research Command

> Multi-source web research aggregation with structured output, manifest tracking, and subagent workflow support

## Usage

```bash
cleo research [OPTIONS] "QUERY"
cleo research --url URL [URL...]
cleo research --reddit "TOPIC" --subreddit SUB
cleo research --library NAME [--topic TOPIC]
cleo research <subcommand> [OPTIONS]
```

## Overview

The `research` command creates structured research plans that aggregate content from multiple web sources using MCP servers (Tavily, Context7, Sequential-thinking). It produces JSON + Markdown outputs with full citation tracking and manifest-based discovery.

This command implements the [Web Aggregation Pipeline Specification](../specs/WEB-AGGREGATION-PIPELINE-SPEC.md).

## Subcommands

| Subcommand | Description |
|------------|-------------|
| `init` | Initialize research outputs directory with protocol files |
| `list` | List research entries from manifest with filtering |
| `show <id>` | Show details of a research entry from manifest |
| `inject` | Output the subagent injection template for prompts |
| `link <task> <research>` | Link a research entry to a CLEO task |

## Research Modes

| Mode | Trigger | Description |
|------|---------|-------------|
| **Query** | `"query text"` | Free-text comprehensive research |
| **URL** | `--url` | Extract and synthesize from specific URLs |
| **Reddit** | `--reddit` | Reddit discussion search via Tavily |
| **Library** | `--library` | Framework/library docs via Context7 |

## Options

| Option | Short | Description | Default |
|--------|-------|-------------|---------|
| `--depth LEVEL` | `-d` | Search depth: `quick`, `standard`, `deep` | `standard` |
| `--output DIR` | `-o` | Output directory for results | `.cleo/research/` |
| `--topic TOPIC` | `-t` | Topic filter for library mode | - |
| `--subreddit SUB` | `-s` | Subreddit for Reddit mode | - |
| `--include-reddit` | - | Include Reddit in query mode | `false` |
| `--link-task ID` | - | Link research to a task | - |
| `--plan-only` | - | Output plan without executing | `false` |
| `--format FMT` | `-f` | Output format: `json`, `text` | auto |
| `--json` | - | Force JSON output | - |
| `--help` | `-h` | Show help | - |

## Depth Levels

| Depth | Sources | Use Case |
|-------|---------|----------|
| `quick` | 3-5 | Fast overview, top results only |
| `standard` | 8-12 | Balanced coverage (default) |
| `deep` | 15-25 | Comprehensive multi-source research |

---

## Subcommand: init

Initialize the research outputs directory with protocol files.

### Usage

```bash
cleo research init
```

### Description

Creates the research outputs directory structure and copies protocol template files needed for the subagent workflow. Safe to run multiple times (idempotent).

### Created Files

| File/Directory | Purpose |
|----------------|---------|
| `{output_dir}/` | Research outputs directory |
| `{output_dir}/archive/` | Archive for old research files |
| `MANIFEST.jsonl` | Append-only manifest for research entries |
| `SUBAGENT_PROTOCOL.md` | Protocol documentation for subagents |
| `INJECT.md` | Injection template for subagent prompts |

### Examples

```bash
# Initialize with defaults
cleo research init

# JSON output
cleo research init --json
```

### JSON Output

```json
{
  "_meta": {
    "format": "json",
    "command": "research",
    "subcommand": "init"
  },
  "success": true,
  "result": {
    "outputDir": "docs/claudedocs/research-outputs",
    "created": ["docs/claudedocs/research-outputs/", "MANIFEST.jsonl", "SUBAGENT_PROTOCOL.md"]
  }
}
```

### Human Output

```
Research outputs initialized
  Directory: docs/claudedocs/research-outputs
  Manifest:  MANIFEST.jsonl
  Archive:   archive/

Created:
  - docs/claudedocs/research-outputs/
  - MANIFEST.jsonl
  - SUBAGENT_PROTOCOL.md
  - INJECT.md
```

---

## Subcommand: list

List research entries from the manifest with optional filtering.

### Usage

```bash
cleo research list [OPTIONS]
```

### Options

| Option | Description | Default |
|--------|-------------|---------|
| `--status STATUS` | Filter by status: `complete`, `partial`, `blocked`, `archived` | - |
| `--topic TOPIC` | Filter by topic tag (case-insensitive substring match) | - |
| `--since DATE` | Filter entries on or after date (ISO 8601: YYYY-MM-DD) | - |
| `--limit N` | Maximum entries to return | `20` |
| `--actionable` | Only show actionable entries | `false` |

### Examples

```bash
# List all research entries
cleo research list

# Filter by status
cleo research list --status complete

# Filter by topic
cleo research list --topic authentication

# Recent actionable entries
cleo research list --since 2026-01-01 --actionable

# Limit results
cleo research list --limit 5
```

### JSON Output

```json
{
  "_meta": {
    "format": "json",
    "command": "research",
    "subcommand": "list"
  },
  "success": true,
  "summary": {
    "total": 15,
    "returned": 5
  },
  "entries": [
    {
      "id": "auth-patterns-2026-01-15",
      "file": "2026-01-15_auth-patterns.md",
      "title": "Authentication Patterns Research",
      "date": "2026-01-15",
      "status": "complete",
      "topics": ["authentication", "security"],
      "key_findings": ["OAuth 2.1 replaces 2.0", "PKCE is required"],
      "actionable": true,
      "needs_followup": []
    }
  ]
}
```

### Human Output

```
Research Entries
================

ID                        STATUS       TITLE
------------------------- ------------ ----------------------------------------
auth-patterns-2026-01-15  complete     Authentication Patterns Research
api-design-2026-01-14     complete     RESTful API Design Best Practices
state-mgmt-2026-01-10     partial      React State Management Options

Showing 3 of 15 entries
Filters: status=complete limit=20
```

---

## Subcommand: show

Show details of a specific research entry from the manifest.

### Usage

```bash
cleo research show <id> [OPTIONS]
```

### Options

| Option | Description | Default |
|--------|-------------|---------|
| `--full` | Include full file content (WARNING: large context) | `false` |
| `--findings-only` | Only key_findings array | `true` |

### Examples

```bash
# Show entry summary (default - context efficient)
cleo research show auth-patterns-2026-01-15

# Show with full file content (use sparingly)
cleo research show auth-patterns-2026-01-15 --full
```

### JSON Output

```json
{
  "_meta": {
    "format": "json",
    "command": "research",
    "subcommand": "show"
  },
  "success": true,
  "entry": {
    "id": "auth-patterns-2026-01-15",
    "file": "2026-01-15_auth-patterns.md",
    "title": "Authentication Patterns Research",
    "date": "2026-01-15",
    "status": "complete",
    "topics": ["authentication", "security", "oauth"],
    "key_findings": [
      "OAuth 2.1 replaces OAuth 2.0 with mandatory PKCE",
      "Session tokens should use secure httpOnly cookies",
      "JWTs best for stateless APIs, sessions for web apps"
    ],
    "actionable": true,
    "needs_followup": ["Investigate passkey implementation"]
  }
}
```

### Human Output

```
Research: auth-patterns-2026-01-15
==================================================
  Title:      Authentication Patterns Research
  Status:     complete
  Date:       2026-01-15
  File:       2026-01-15_auth-patterns.md
  Actionable: true

Topics:
  - authentication
  - security
  - oauth

Key Findings:
  1. OAuth 2.1 replaces OAuth 2.0 with mandatory PKCE
  2. Session tokens should use secure httpOnly cookies
  3. JWTs best for stateless APIs, sessions for web apps

Needs Follow-up:
  - Investigate passkey implementation
```

---

## Subcommand: inject

Output the subagent injection template for use in Claude Code subagent prompts.

### Usage

```bash
cleo research inject [OPTIONS]
```

### Options

| Option | Description | Default |
|--------|-------------|---------|
| `--raw` | Output template without variable substitution | `false` |
| `--clipboard` | Copy to clipboard (pbcopy/xclip/xsel/wl-copy) | `false` |

### Description

Returns the injection block that MUST be included in every research subagent prompt to ensure consistent output format and manifest tracking. The injection template instructs subagents to:

1. Write findings to: `{output_dir}/YYYY-MM-DD_{topic-slug}.md`
2. Append ONE line to: `{output_dir}/MANIFEST.jsonl`
3. Return ONLY: "Research complete. See MANIFEST.jsonl for summary."
4. NOT return research content in response (context efficiency)

### Examples

```bash
# Output injection template (substituted)
cleo research inject

# Raw template with placeholders
cleo research inject --raw

# Copy to clipboard
cleo research inject --clipboard
```

### Output

```
OUTPUT REQUIREMENTS (RFC 2119):
1. MUST write findings to: docs/claudedocs/research-outputs/YYYY-MM-DD_{topic-slug}.md
2. MUST append ONE line to: docs/claudedocs/research-outputs/MANIFEST.jsonl
3. MUST return ONLY: "Research complete. See MANIFEST.jsonl for summary."
4. MUST NOT return research content in response.

Manifest entry format (single line):
{"id":"topic-YYYY-MM-DD","file":"YYYY-MM-DD_topic.md","title":"Title","date":"YYYY-MM-DD","status":"complete|partial|blocked","topics":["t1"],"key_findings":["Finding 1","Finding 2"],"actionable":true,"needs_followup":[]}
```

---

## Subcommand: link

Link a research entry to a CLEO task by adding a note with the research reference.

### Usage

```bash
cleo research link <task-id> <research-id> [OPTIONS]
```

### Options

| Option | Description | Default |
|--------|-------------|---------|
| `--notes TEXT` | Custom note text (appended to default link text) | - |
| `--unlink` | Remove link (not yet implemented) | `false` |

### Description

Validates both the task and research entry exist, then adds a timestamped note to the task with the research reference. This creates a traceable connection between research findings and actionable tasks.

### Examples

```bash
# Link research to task
cleo research link T042 auth-patterns-2026-01-15

# With custom note
cleo research link T042 auth-patterns-2026-01-15 --notes "Implements OAuth 2.1 recommendations"
```

### JSON Output

```json
{
  "_meta": {
    "format": "json",
    "command": "research",
    "subcommand": "link"
  },
  "success": true,
  "result": {
    "taskId": "T042",
    "researchId": "auth-patterns-2026-01-15",
    "researchTitle": "Authentication Patterns Research",
    "action": "linked",
    "taskNote": "Linked research: auth-patterns-2026-01-15 (Authentication Patterns Research). Implements OAuth 2.1 recommendations"
  }
}
```

### Human Output

```
Linked research to task
  Task:     T042
  Research: auth-patterns-2026-01-15 (Authentication Patterns Research)
```

---

## Research Workflow Examples

### Query Mode

```bash
# Basic research
cleo research "TypeScript decorators best practices"

# Deep research with Reddit
cleo research "React state management 2024" --include-reddit -d deep

# Link research to task during creation
cleo research "API design patterns" --link-task T042
```

### URL Mode

```bash
# Extract from specific URLs
cleo research --url https://blog.example.com/article1 https://docs.lib.dev/guide
```

### Reddit Mode

```bash
# Search Reddit discussions
cleo research --reddit "authentication" --subreddit webdev

# Top posts from subreddit
cleo research --reddit "state management" -s reactjs
```

### Library Mode

```bash
# Framework documentation
cleo research --library svelte --topic reactivity

# With specific topic
cleo research --library "next.js" --topic "app router"
```

---

## Subagent Workflow

The research system is designed to work with Claude Code subagents for context-efficient research.

### Orchestrator Pattern

1. **Initialize** the research outputs directory:
   ```bash
   cleo research init
   ```

2. **Get the injection template** for subagent prompts:
   ```bash
   cleo research inject
   ```

3. **Spawn subagent** with the injection block prepended to the research task.

4. **Query manifest** (not full files) for research summaries:
   ```bash
   cleo research list --status complete --limit 10
   cleo research show <id>
   ```

5. **Link research** to actionable tasks:
   ```bash
   cleo research link T042 auth-patterns-2026-01-15
   ```

### Subagent Requirements

Subagents receiving the injection template MUST:

1. Write findings to: `{output_dir}/YYYY-MM-DD_{topic-slug}.md`
2. Append ONE line to: `{output_dir}/MANIFEST.jsonl`
3. Return ONLY: "Research complete. See MANIFEST.jsonl for summary."
4. NOT return research content in response

This pattern ensures:
- **Context efficiency**: Orchestrator never loads full research files
- **Discoverability**: All research indexed in manifest
- **Traceability**: Research linked to tasks via notes
- **Compliance**: RFC 2119 requirements enforced

### Manifest Entry Format

```json
{
  "id": "topic-slug-YYYY-MM-DD",
  "file": "YYYY-MM-DD_topic-slug.md",
  "title": "Human Readable Title",
  "date": "YYYY-MM-DD",
  "status": "complete|partial|blocked",
  "topics": ["tag1", "tag2"],
  "key_findings": ["Finding 1", "Finding 2"],
  "actionable": true,
  "needs_followup": []
}
```

---

## Output Files

### Research Plan Files

| File | Content |
|------|---------|
| `research_[id]_plan.json` | Execution plan with stages |
| `research_[id]_[query].json` | Structured results (after execution) |
| `research_[id]_[query].md` | Markdown report (after execution) |

### Subagent Output Files

| File | Content |
|------|---------|
| `YYYY-MM-DD_{topic-slug}.md` | Research findings document |
| `MANIFEST.jsonl` | Append-only index of all research |

### JSON Structure (Research Plan)

```json
{
  "$schema": "cleo://research/plan/v1",
  "research_id": "R9485o4i",
  "mode": "query",
  "query": "TypeScript best practices",
  "depth": "standard",
  "execution_plan": {
    "stages": [
      {"stage": 1, "name": "discovery", "tools": ["tavily_search", "WebSearch"]},
      {"stage": 2, "name": "library_check", "tools": ["mcp__context7__*"]},
      {"stage": 3, "name": "extraction", "tools": ["tavily_extract", "WebFetch"]},
      {"stage": 4, "name": "synthesis", "tools": ["mcp__sequential-thinking__*"]},
      {"stage": 5, "name": "output", "tools": ["Write"]}
    ]
  },
  "output": {
    "directory": ".cleo/research",
    "json_file": "research_R9485o4i_typescript.json",
    "markdown_file": "research_R9485o4i_typescript.md"
  }
}
```

---

## Configuration

Research output locations are configurable in `.cleo/config.json`:

```json
{
  "research": {
    "outputDir": "docs/claudedocs/research-outputs",
    "manifestFile": "MANIFEST.jsonl"
  }
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `research.outputDir` | `docs/claudedocs/research-outputs` | Directory for research output files |
| `research.manifestFile` | `MANIFEST.jsonl` | Manifest filename |

---

## MCP Servers Used

| Server | Purpose | Required |
|--------|---------|----------|
| **Tavily** | Web search and extraction | Recommended |
| **Context7** | Library documentation | Recommended |
| **Sequential-thinking** | Multi-source synthesis | Recommended |
| **WebSearch** | Fallback search | Built-in |
| **WebFetch** | Fallback extraction | Built-in |

---

## Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Success |
| `2` | Invalid input (missing query, invalid depth, bad date format) |
| `4` | Not found (task or research entry) |
| `5` | Dependency error (clipboard utility not found) |
| `6` | Validation error (invalid manifest entry) |
| `101` | Already exists (duplicate manifest entry ID) |

---

## Related Commands

- `show` - View task details including linked research
- `update --notes` - Manually add research findings to task notes
- `find` - Search for tasks with research links

## Related Specifications

- [Web Aggregation Pipeline Specification](../specs/WEB-AGGREGATION-PIPELINE-SPEC.md) - Full pipeline architecture
- [Web Aggregation Implementation Report](../specs/WEB-AGGREGATION-PIPELINE-IMPLEMENTATION-REPORT.md) - Implementation status
- [Subagent Protocol](../../templates/subagent-protocol/SUBAGENT_PROTOCOL.md) - Protocol documentation

## Alias

```bash
cleo dig "query"   # Same as 'research'
```
