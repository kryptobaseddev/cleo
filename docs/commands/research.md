# research Command

> Multi-source web research aggregation with structured output and citation tracking

## Usage

```bash
claude-todo research [OPTIONS] "QUERY"
claude-todo research --url URL [URL...]
claude-todo research --reddit "TOPIC" --subreddit SUB
claude-todo research --library NAME [--topic TOPIC]
```

## Overview

The `research` command creates structured research plans that aggregate content from multiple web sources using MCP servers (Tavily, Context7, Sequential-thinking). It produces JSON + Markdown outputs with full citation tracking.

This command implements the [Web Aggregation Pipeline Specification](../specs/WEB-AGGREGATION-PIPELINE-SPEC.md).

## Modes

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
| `--output DIR` | `-o` | Output directory for results | `.claude/research/` |
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

## Examples

### Query Mode

```bash
# Basic research
claude-todo research "TypeScript decorators best practices"

# Deep research with Reddit
claude-todo research "React state management 2024" --include-reddit -d deep

# Link research to task
claude-todo research "API design patterns" --link-task T042
```

### URL Mode

```bash
# Extract from specific URLs
claude-todo research --url https://blog.example.com/article1 https://docs.lib.dev/guide
```

### Reddit Mode

```bash
# Search Reddit discussions
claude-todo research --reddit "authentication" --subreddit webdev

# Top posts from subreddit
claude-todo research --reddit "state management" -s reactjs
```

### Library Mode

```bash
# Framework documentation
claude-todo research --library svelte --topic reactivity

# With specific topic
claude-todo research --library "next.js" --topic "app router"
```

## Output

### Files Created

| File | Content |
|------|---------|
| `research_[id]_plan.json` | Execution plan with stages |
| `research_[id]_[query].json` | Structured results (after execution) |
| `research_[id]_[query].md` | Markdown report (after execution) |

### JSON Structure

```json
{
  "$schema": "claude-todo://research/plan/v1",
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
    "directory": ".claude/research",
    "json_file": "research_R9485o4i_typescript.json",
    "markdown_file": "research_R9485o4i_typescript.md"
  }
}
```

### Execution Flow

```
claude-todo research "query"
    │
    ▼
Creates plan in .claude/research/
    │
    ▼
Claude reads plan and executes stages:
  1. Discovery (Tavily/WebSearch)
  2. Library Check (Context7)
  3. Extraction (Tavily Extract/WebFetch)
  4. Synthesis (Sequential Thinking)
  5. Output (Write JSON + Markdown)
    │
    ▼
Results saved to .claude/research/
```

## MCP Servers Used

| Server | Purpose | Required |
|--------|---------|----------|
| **Tavily** | Web search and extraction | Recommended |
| **Context7** | Library documentation | Recommended |
| **Sequential-thinking** | Multi-source synthesis | Recommended |
| **WebSearch** | Fallback search | Built-in |
| **WebFetch** | Fallback extraction | Built-in |

## Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Success - plan created |
| `2` | Invalid input (missing query, invalid depth) |
| `3` | File system error |

## Related Commands

- `analyze` - Task triage (different purpose)
- `show` - View task details including linked research
- `update --notes` - Add research findings to task notes

## Related Specifications

- [Web Aggregation Pipeline Specification](../specs/WEB-AGGREGATION-PIPELINE-SPEC.md) - Full pipeline architecture
- [Web Aggregation Implementation Report](../specs/WEB-AGGREGATION-PIPELINE-IMPLEMENTATION-REPORT.md) - Implementation status

## Alias

```bash
claude-todo dig "query"   # Same as 'research'
```
