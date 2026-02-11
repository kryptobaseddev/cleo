# Pagination Migration Guide

**Since**: v0.88.0
**Epic**: T1432 (JSON Output System with Smart Pagination)

---

## What Changed

Starting in v0.88.0, CLEO commands that return arrays now apply **smart default limits** and include **pagination metadata** in JSON output.

### Changes Summary

| Area | Before | After |
|------|--------|-------|
| `ct session list` | Returns all sessions | Returns 10 sessions by default |
| `ct find "query"` | Returns all matches | Returns 10 matches by default |
| `ct log` | Returns all entries (or `--limit`) | Returns 20 entries by default |
| JSON envelope | No pagination object | Includes `pagination` object |
| List item detail | Full task/session objects | Compact representations (fewer fields) |

### New Pagination Envelope

Paginated responses include a `pagination` object:

```json
{
  "success": true,
  "pagination": {
    "total": 150,
    "limit": 50,
    "offset": 0,
    "hasMore": true
  },
  "tasks": [ ... ]
}
```

---

## How Agents Should Adapt

### Check hasMore

After any list command, check `pagination.hasMore` to determine if more results exist:

```bash
result=$(ct list)
has_more=$(echo "$result" | jq -r '.pagination.hasMore')

if [[ "$has_more" == "true" ]]; then
  # Fetch next page
  next_offset=$(echo "$result" | jq '.pagination.offset + .pagination.limit')
  result2=$(ct list --offset "$next_offset")
fi
```

### Use --limit and --offset

| Flag | Purpose | Example |
|------|---------|---------|
| `--limit N` | Set page size | `ct list --limit 100` |
| `--limit 0` | Disable pagination (all items) | `ct session list --limit 0` |
| `--offset N` | Skip first N items | `ct list --offset 50` |

### Compact Output

List views now use compact representations. Fields like `notes`, `description`, `acceptance`, `files`, and `verification` are stripped from list output. To get full details for a specific item, use `ct show <id>`.

---

## Backward Compatibility

### Getting Full Listings

To restore pre-v0.88.0 behavior (all items, no pagination), pass `--limit 0`:

```bash
ct session list --limit 0   # All sessions
ct list --limit 0            # All tasks
ct log --limit 0             # All log entries
```

### Pagination Field is Additive

The `pagination` field is a new addition to the JSON envelope. Existing code that parses `success`, `_meta`, and data arrays will continue to work. The `pagination` object can be safely ignored by agents that do not need it.

### Default Limits by Command

| Command | Default Limit |
|---------|:------------:|
| `list` | 50 |
| `session list` | 10 |
| `find` | 10 |
| `log` | 20 |
| `archive` | 25 |

---

## Recommended Agent Pattern

The most context-efficient pattern for agents:

1. **Discover** with `ct find "query"` (10 compact results)
2. **Inspect** with `ct show T1234` (full detail for one item)
3. **Iterate** with `--offset` only when `hasMore` is true

This keeps context consumption under 3K tokens for typical operations.

---

## Related Documentation

- **Spec**: `docs/specs/DYNAMIC-OUTPUT-LIMITS-SPEC.md`
- **API Reference**: `docs/reference/json-output-api.md`
- **CLI Design Standard**: `docs/developer/specifications/LLM-AGENT-FIRST.mdx` (Part 14)
