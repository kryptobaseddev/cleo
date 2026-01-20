# Subagent Research Output Protocol v2.0.0

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in RFC 2119.

---

## Configuration

```yaml
output_dir: claudedocs/research-outputs
manifest_file: MANIFEST.jsonl
archive_dir: claudedocs/research-outputs/archive
```

Projects MUST set `output_dir` to their preferred location. All paths below reference this configuration.

---

## Subagent Requirements

### Output File

Subagents MUST write findings to: `{output_dir}/YYYY-MM-DD_{topic-slug}.md`

File format:

```markdown
# {Title}
**Date**: YYYY-MM-DD | **Agent**: {agent-type} | **Status**: complete|partial|blocked

---

## Executive Summary
{3-5 sentences max}

---

## Findings
{detailed content}

---

## Recommendations
{numbered list}

---

## Open Questions
{unresolved items}
```

### Manifest Entry

Subagents MUST append ONE line to `{output_dir}/{manifest_file}`:

```json
{"id":"topic-slug-YYYY-MM-DD","file":"YYYY-MM-DD_topic-slug.md","title":"Human Title","date":"YYYY-MM-DD","status":"complete","topics":["tag1","tag2"],"key_findings":["Finding 1","Finding 2"],"actionable":true,"needs_followup":[]}
```

Field requirements:
| Field | Required | Constraint |
|-------|----------|------------|
| id | MUST | Unique slug with date |
| file | MUST | Matches output filename |
| title | MUST | Human-readable |
| date | MUST | ISO 8601 date |
| status | MUST | `complete`, `partial`, or `blocked` |
| topics | MUST | Array, 1+ items |
| key_findings | MUST | Array, 3-7 items, one sentence each |
| actionable | MUST | Boolean |
| needs_followup | MUST | Array, MAY be empty |

### Response

Subagents MUST return ONLY: `Research complete. See {manifest_file} for summary.`

Subagents MUST NOT return research content in the response.

---

## Orchestrator Requirements

Orchestrators MUST include the injection block (see INJECT.md) in every research subagent prompt.

Orchestrators MUST NOT read full research files into context.

Orchestrators SHOULD read only `{manifest_file}` for research summaries.

Orchestrators MAY use targeted Grep/Read with line limits for specific details.

---

## Manifest Operations

### Read all entries
```bash
cat {output_dir}/MANIFEST.jsonl | jq -s '.'
```

### Query specific fields
```bash
cat {output_dir}/MANIFEST.jsonl | jq -s '.[] | {id, title, key_findings}'
```

### Rebuild from files (recovery)
```bash
for f in {output_dir}/*.md; do
  title=$(head -1 "$f" | sed 's/^# //')
  echo "Found: $title"
done
```

---

## Cleanup

Files older than 30 days with `actionable: false` MAY be archived:

```bash
mv {output_dir}/old-file.md {archive_dir}/
```

Archived entries SHOULD remain in `{manifest_file}` with status updated to `archived`.

---

## Compliance

A subagent is compliant if:
1. Output file exists at specified path
2. Manifest entry appended (file contains entry with matching `id`)
3. Response contains only the required completion message

Non-compliant outputs SHOULD be flagged by orchestrator for manual review.
