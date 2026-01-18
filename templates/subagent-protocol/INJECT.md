# Subagent Injection Template

Copy this block into every research subagent prompt. Replace `{output_dir}` with your project's path.

---

```
OUTPUT REQUIREMENTS (RFC 2119):
1. MUST write findings to: {output_dir}/YYYY-MM-DD_{topic-slug}.md
2. MUST append ONE line to: {output_dir}/MANIFEST.jsonl
3. MUST return ONLY: "Research complete. See MANIFEST.jsonl for summary."
4. MUST NOT return research content in response.

Manifest entry format (single line):
{"id":"topic-YYYY-MM-DD","file":"YYYY-MM-DD_topic.md","title":"Title","date":"YYYY-MM-DD","status":"complete|partial|blocked","topics":["t1"],"key_findings":["Finding 1","Finding 2"],"actionable":true,"needs_followup":[]}

Output file format:
# {Title}
**Date**: YYYY-MM-DD | **Agent**: {type} | **Status**: complete|partial|blocked

## Executive Summary
{3-5 sentences}

## Findings
{content}

## Recommendations
{list}

## Open Questions
{unresolved}
```
