# Pagination Migration Guide

**Since**: v0.88.0
**Epic**: T1432 (JSON Output System with Smart Pagination)

---

## What Changed

CLEO list operations now standardize on a shared MCP list contract:

- Canonical pagination metadata lives in the top-level `page` field.
- `tasks.list` is the reference implementation for list responses and filter parity.
- `session.list`, admin list operations, `pipeline.manifest.list`, `pipeline.release.list`, and the remaining sticky/nexus/tools/orchestrate/pipeline list surfaces follow the same shape.
- `find` remains the preferred discovery path when you already know what you are looking for.

### Changes Summary

| Area | Before | After |
|------|--------|-------|
| `tasks.list` | Mixed list shapes across surfaces | Canonical list contract and shared `page` handling |
| `session.list` | Legacy metadata only | Canonical top-level `page` plus legacy `_meta` mirror |
| Other MCP `*.list` surfaces | Inconsistent pagination behavior | Standardized `limit` / `offset` + top-level `page` |
| Discovery pattern | `list` and `find` often used interchangeably | `find` for discovery, `list` for browsing/filtering |
| Task list rows | Caller-selected compact/full behavior | MCP defaults to compact rows; `compact` remains compatibility-only |

### Canonical List Envelope

List responses expose pagination in top-level `page`:

```json
{
  "_meta": {
    "gateway": "query",
    "domain": "tasks",
    "operation": "list"
  },
  "success": true,
  "data": {
    "tasks": [ ... ],
    "total": 150,
    "filtered": 87
  },
  "page": {
    "mode": "offset",
    "limit": 50,
    "offset": 0,
    "hasMore": true,
    "total": 87
  }
}
```

When pagination is not active, `page` is still present and set to:

```json
{
  "page": {
    "mode": "none"
  }
}
```

---

## How Agents Should Adapt

### Prefer `find` for discovery

Use `find` when you want a lightweight shortlist. Use `list` when you need ordered browsing, structured filters, or page-by-page iteration.

- `tasks.find` -> discovery and narrowing
- `tasks.list` -> filtered browsing and pagination
- `tasks.show` -> full detail for one task

The same pattern applies to other domains that expose both verbs.

### Check `page.mode` and `page.hasMore`

After any list operation, read top-level `page` first:

```bash
page_mode=$(echo "$result" | jq -r '.page.mode')

if [[ "$page_mode" == "offset" ]]; then
  has_more=$(echo "$result" | jq -r '.page.hasMore')
  if [[ "$has_more" == "true" ]]; then
    next_offset=$(echo "$result" | jq '.page.offset + .page.limit')
  fi
fi
```

### Use `limit` and `offset`

| Param | Purpose | Example |
|------|---------|---------|
| `limit` | Set page size | `tasks.list {"limit": 100}` |
| `offset` | Skip items before this page | `tasks.list {"offset": 50}` |

`tasks.list` and `session.list` also have CLI equivalents. Other standardized MCP list surfaces use the same pagination parameters when supported.

### Smart Defaults

- `tasks.list` in MCP defaults to compact task rows. Pass `compact: false` only when you explicitly need the compatibility path.
- `session.list` applies a default `limit` of `10` when none is provided.
- Other standardized `*.list` operations honor explicit `limit` / `offset`; if you need a bounded response, request it directly.

Compact task rows intentionally omit verbose fields. Use `tasks.show` for full task detail.

---

## Backward Compatibility

### Canonical Pagination Source

Read pagination state from top-level `page`, not from per-operation compatibility fields.

- `session.list` still mirrors legacy `data._meta.truncated` and `data._meta.total` for older consumers.
- `tasks.list` still accepts `compact` for compatibility.
- New integrations SHOULD treat `page` as the canonical source and `show` as the full-detail follow-up.

---

## Recommended Agent Pattern

The most context-efficient pattern for agents:

1. **Discover** with `tasks.find` when a shortlist is enough
2. **Browse** with `tasks.list` when you need filters or stable pagination
3. **Inspect** with `tasks.show` for full detail
4. **Iterate** with `offset` only when `page.mode == "offset"` and `page.hasMore == true`

This keeps context usage low while staying aligned with the canonical list contract.

---

## Related Documentation

- **Spec**: `docs/mintlify/specs/DYNAMIC-OUTPUT-LIMITS-SPEC.md`
- **API Reference**: `docs/mintlify/reference/json-output-api.md`
