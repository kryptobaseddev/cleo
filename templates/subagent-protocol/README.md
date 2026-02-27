# Subagent Research Output Protocol

**v2.0.0** | RFC 2119 Compliant | Project-Agnostic

Persistent research output management for Claude Code orchestrator/subagent workflows.

## Problem Solved

- Subagent outputs disappear in ephemeral `/tmp` files
- Parallel subagents cause race conditions on shared manifest
- Orchestrator context overflows reading full research files
- No standard format for research handoff

## Solution

- **JSONL manifest** - append-only, no race conditions
- **Structured output files** - consistent format for all research
- **Injection template** - copy-paste block for subagent prompts
- **RFC 2119 language** - unambiguous requirements

## Installation

```bash
# From this template directory
mkdir -p /path/to/project/.cleo/agent-outputs
cp SUBAGENT_PROTOCOL.md INJECT.md MANIFEST.jsonl /path/to/project/.cleo/agent-outputs/
```

Or with a one-liner:

```bash
# Set your target project
TARGET=/path/to/project/.cleo/agent-outputs
mkdir -p "$TARGET" && cp SUBAGENT_PROTOCOL.md INJECT.md MANIFEST.jsonl "$TARGET/"
```

## Configuration

Edit the config block in `SUBAGENT_PROTOCOL.md` for your project:

```yaml
output_dir: .cleo/agent-outputs  # Change this
manifest_file: MANIFEST.jsonl
archive_dir: .cleo/agent-outputs/archive
```

## Usage

### Orchestrator

1. Read `INJECT.md` for the template block
2. Include injection block in every research subagent prompt
3. Read `MANIFEST.jsonl` for summaries (not full files)

```bash
# Get all research summaries
cat MANIFEST.jsonl | jq -s '.[] | {id, title, key_findings}'
```

### Subagent

1. Write findings to `{output_dir}/YYYY-MM-DD_{topic-slug}.md`
2. Append ONE line to `MANIFEST.jsonl`
3. Return ONLY: `Research complete. See MANIFEST.jsonl for summary.`

## Files

| File | Purpose |
|------|---------|
| `SUBAGENT_PROTOCOL.md` | Full specification |
| `INJECT.md` | Copy-paste template for prompts |
| `MANIFEST.jsonl` | Append-only research index |

## License

MIT - Use freely in any project.
