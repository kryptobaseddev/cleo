# T3124: Manifest System Architecture Design for MCP

**Task**: T3124
**Epic**: T3118
**Date**: 2026-02-06
**Status**: complete
**Agent Type**: specification

---

## Summary

This design document maps CLEO's manifest system to the MCP server's 2-tool CQRS gateway (`cleo_query` + `cleo_mutate`). It identifies the gap between the MCP spec (Section 6) and current implementation, defines command naming conventions, validates the research domain routing for manifest operations, and specifies the migration path from the current partial implementation to full spec compliance.

---

## 1. Current State Analysis

### 1.1 Spec Requirements (MCP-SERVER-SPECIFICATION.md)

The MCP spec defines manifest operations split across two domains:

**cleo_query (research domain)**:
| Operation | Spec Section | Status |
|-----------|-------------|--------|
| `manifest.read` | Section 2.2.1 | Implemented |
| `manifest.validate` | N/A (added in impl) | Implemented |
| `manifest.summary` | N/A (added in impl) | Implemented |
| `show` | Section 2.2.1 | Implemented (via CLI) |
| `list` | Section 2.2.1 | Implemented (via CLI) |
| `stats` | Section 2.2.1 | Implemented (via CLI) |
| `pending` | Section 2.2.1 | NOT implemented |
| `query` | Section 2.2.1 | NOT implemented |

**cleo_query (validate domain)**:
| Operation | Spec Section | Status |
|-----------|-------------|--------|
| `manifest` | Section 2.2.1 | NOT implemented |

**cleo_mutate (research domain)**:
| Operation | Spec Section | Status |
|-----------|-------------|--------|
| `manifest.append` | Section 2.2.2 | NOT implemented |
| `manifest.archive` | Section 2.2.2 | NOT implemented |
| `link` | Section 2.2.2 | Implemented (via CLI) |
| `inject` | Section 2.2.2 | NOT implemented |

### 1.2 Current Implementation (research.ts)

The `ResearchHandler` currently supports:

**Query operations (8)**: `list`, `stats`, `validate`, `search`, `export`, `manifest.read`, `manifest.validate`, `manifest.summary`

**Mutate operations (5)**: `link`, `unlink`, `import`, `aggregate`, `report`

### 1.3 Library Layer (lib/research-manifest.sh)

The Bash library (`lib/research-manifest.sh`, 2707 lines, 47 functions) provides comprehensive manifest CRUD operations including:
- `read_manifest()`, `append_manifest()`, `find_entry()`, `filter_entries()`
- `archive_entry()`, `update_entry()`, `get_entry_by_id()`
- `link_research_to_task()`, `unlink_research_from_task()`
- `validate_research_manifest()`, `get_manifest_stats()`
- `manifest_archive_old()`, `manifest_rotate()`, `compact_manifest()`

### 1.4 CLI Layer (scripts/research.sh)

The CLI exposes subcommands: `init`, `list`, `show`, `inject`, `link`, `pending`, `archive`, `archive-list`, `status`, `stats`, `validate`

**Critical gap**: No `add` subcommand -- agents must manually append JSONL.

---

## 2. Gap Analysis: Spec vs Implementation

### 2.1 Missing Query Operations

| Spec Operation | Gap | Remediation |
|----------------|-----|-------------|
| `pending` | Not in MCP handler | Add to `ResearchHandler.query()`, map to CLI `cleo research pending` |
| `query` | Partially present as `search` | Rename internal `search` to `query` for spec alignment, or add `query` as alias |
| `validate.manifest` | Cross-domain | Add to `ValidateHandler.query()`, delegate to `ManifestReader.validateManifest()` |

### 2.2 Missing Mutate Operations

| Spec Operation | Gap | Remediation | Priority |
|----------------|-----|-------------|----------|
| `manifest.append` | Not implemented | New handler method, maps to `append_manifest()` or direct TS implementation | CRITICAL |
| `manifest.archive` | Not implemented | New handler method, maps to CLI `cleo research archive` or `manifest_archive_old()` | HIGH |
| `inject` | Not implemented | New handler method, maps to CLI `cleo research inject` | MEDIUM |

### 2.3 Implementation Extras (Not in Spec)

| Operation | Domain | Gateway | Disposition |
|-----------|--------|---------|-------------|
| `export` | research | query | Keep -- useful for bulk data extraction |
| `unlink` | research | mutate | Keep -- inverse of `link` |
| `import` | research | mutate | Keep -- bulk ingestion |
| `aggregate` | research | mutate | Keep -- cross-entry synthesis |
| `report` | research | mutate | Keep -- report generation |
| `manifest.validate` | research | query | Keep -- but also add to validate domain |
| `manifest.summary` | research | query | Keep -- aggregate stats |

---

## 3. Command Naming Conventions

### 3.1 Domain Routing Pattern

All manifest operations use the `research` domain with dot-notation for manifest-specific suboperations:

```
cleo_{gateway} research {operation}
```

**Naming rules**:
1. Top-level research operations use simple names: `list`, `stats`, `link`
2. Manifest-specific operations use `manifest.` prefix: `manifest.read`, `manifest.append`
3. Cross-domain validation uses `validate.manifest` in the validate domain
4. Dot-notation creates a natural hierarchy without requiring a separate `manifest` domain

### 3.2 Operation Naming Map

```
CLI Command                    MCP Operation              Gateway
-----------                    -------------              -------
cleo research list             research.list              cleo_query
cleo research show <id>        research.show              cleo_query
cleo research stats            research.stats             cleo_query
cleo research pending          research.pending           cleo_query
cleo research search <q>       research.query             cleo_query
cleo research validate         research.manifest.validate cleo_query
cleo research add <entry>      research.manifest.append   cleo_mutate
cleo research archive          research.manifest.archive  cleo_mutate
cleo research link <t> <r>     research.link              cleo_mutate
cleo research unlink <t> <r>   research.unlink            cleo_mutate
cleo research inject <proto>   research.inject            cleo_mutate
```

---

## 4. Subcommand Structure

### 4.1 Research Domain -- Final Operation Surface

**Query Operations (8 total)**:

| # | Operation | Parameters | Returns | Implementation |
|---|-----------|------------|---------|----------------|
| 1 | `list` | `taskId?`, `status?`, `type?`, `topic?`, `limit?`, `actionable?` | Entry array | CLI passthrough |
| 2 | `show` | `researchId` | Full entry | CLI passthrough |
| 3 | `stats` | `epicId?` | Aggregated metrics | CLI passthrough |
| 4 | `pending` | `epicId?`, `brief?` | Entries needing follow-up | CLI passthrough |
| 5 | `query` | `query`, `confidence?`, `limit?` | Matched entries | CLI passthrough |
| 6 | `manifest.read` | `filter?`, `limit?` | JSONL entries | Direct ManifestReader |
| 7 | `manifest.validate` | none | Validation results | Direct ManifestReader |
| 8 | `manifest.summary` | none | Summary statistics | Direct ManifestReader |

**Mutate Operations (7 total)**:

| # | Operation | Parameters | Returns | Implementation |
|---|-----------|------------|---------|----------------|
| 1 | `manifest.append` | `entry` (ManifestEntry), `validateFile?` | Entry confirmation | Direct TS + ManifestReader |
| 2 | `manifest.archive` | `beforeDate?`, `moveFiles?` | Archive count | CLI passthrough |
| 3 | `link` | `taskId`, `researchId`, `notes?` | Link confirmation | CLI passthrough |
| 4 | `unlink` | `taskId`, `researchId` | Unlink confirmation | CLI passthrough |
| 5 | `inject` | `protocolType`, `taskId?`, `variant?` | Protocol block | CLI passthrough |
| 6 | `import` | `source`, `overwrite?` | Import count | CLI passthrough |
| 7 | `report` | `epicId?`, `format?`, `includeLinks?` | Report content | CLI passthrough |

### 4.2 Cross-Domain: Validate Domain

Add `manifest` operation to ValidateHandler:

| Operation | Parameters | Returns | Implementation |
|-----------|------------|---------|----------------|
| `manifest` | `entry?` or `taskId?` | Integrity status | Delegate to ManifestReader.validateEntry/validateManifest |

---

## 5. MCP Tool Mapping

### 5.1 cleo_query Manifest Operations

```typescript
// Gateway: cleo_query
// Domain: research

// manifest.read - Read and filter manifest entries
{
  domain: "research",
  operation: "manifest.read",
  params: {
    taskId?: string,      // Filter by task ID
    agent_type?: string,  // Filter by agent type
    status?: string,      // Filter by status
    topic?: string,       // Filter by topic
    dateAfter?: string,   // Filter by date range
    dateBefore?: string,  // Filter by date range
    actionable?: boolean, // Filter by actionable flag
    limit?: number        // Max entries to return
  }
}

// manifest.validate - Validate manifest integrity
{
  domain: "research",
  operation: "manifest.validate",
  params: {}  // No parameters, validates entire manifest
}

// manifest.summary - Get manifest statistics
{
  domain: "research",
  operation: "manifest.summary",
  params: {}  // No parameters, returns aggregated stats
}
```

### 5.2 cleo_mutate Manifest Operations

```typescript
// Gateway: cleo_mutate
// Domain: research

// manifest.append - Append new manifest entry
{
  domain: "research",
  operation: "manifest.append",
  params: {
    entry: {
      id: string,           // Required: T####-slug format
      file: string,          // Required: relative path to output file
      title: string,         // Required: human-readable title
      date?: string,         // Optional: defaults to today (YYYY-MM-DD)
      status: string,        // Required: complete | partial | blocked
      agent_type: string,    // Required: protocol type used
      topics: string[],      // Required: category tags (3-7 items)
      key_findings?: string[],    // Optional: 3-7 items for research
      actionable: boolean,        // Required: whether findings are actionable
      needs_followup?: string[],  // Optional: task IDs needing follow-up
      linked_tasks?: string[],    // Optional: related task IDs
      confidence?: number,        // Optional: 0.0-1.0
      file_checksum?: string,     // Optional: SHA256 of output file
      duration_seconds?: number   // Optional: wall-clock time
    },
    validateFile?: boolean  // Optional: verify output file exists
  }
}

// manifest.archive - Archive old manifest entries
{
  domain: "research",
  operation: "manifest.archive",
  params: {
    beforeDate?: string,  // Archive entries before this date
    moveFiles?: boolean   // Also move referenced output files
  }
}
```

### 5.3 Implementation Strategy for manifest.append

The `manifest.append` operation is the critical gap. Two implementation paths:

**Path A: Direct TypeScript (Recommended)**

```typescript
// In ResearchHandler
private async mutateManifestAppend(params: ManifestAppendParams): Promise<DomainResponse> {
  // 1. Validate entry using ManifestReader.validateEntry()
  // 2. If validateFile, check file exists using fs.access()
  // 3. Serialize entry to single-line JSON using serializeEntry()
  // 4. Append to MANIFEST.jsonl with atomic write (temp + rename)
  // 5. Return entry confirmation with generated fields (date if omitted)
}
```

**Advantages**: No CLI dependency, uses existing TypeScript validation, atomic append semantics.

**Path B: CLI Passthrough**

Requires implementing `cleo research add` in `scripts/research.sh` first, which maps to `append_manifest()` in `lib/research-manifest.sh`. The MCP handler then calls the CLI.

**Advantages**: Single source of truth in Bash, tested via BATS, consistent with other operations.

**Recommendation**: Path A for the MCP server, because `manifest.append` is the most frequently called manifest operation by subagents, and eliminating the CLI fork overhead matters. However, the CLI command (`cleo research add`) should still be implemented for non-MCP workflows. Both should share validation logic conceptually.

---

## 6. Validation Requirements (Section 8.2 Compliance)

### 6.1 Pre-Append Validation (MUST)

| Rule | Check | Severity | Implementation |
|------|-------|----------|----------------|
| Valid JSON | Entry is valid JSON object | Error | `JSON.parse()` + type check |
| ID Format | Matches `^T\d{3,}-[a-z0-9-]+$` | Error | Regex validation |
| ID Uniqueness | No duplicate ID in manifest | Error | Read + scan existing entries |
| Date Format | ISO 8601 YYYY-MM-DD | Error | Regex + Date parse |
| Date Not Future | Date <= today | Warning | Compare to `new Date()` |
| Status Enum | One of: `complete`, `partial`, `blocked` | Error | Enum check |
| Agent Type Valid | Known protocol type string | Error | String length check |
| Topics Array | Non-empty string array | Error | Type + length check |
| Topics Count | 3-7 items recommended | Warning | Length check |
| Key Findings Count | 3-7 items when present | Warning | Length check |
| Actionable Boolean | Must be boolean type | Error | Type check |
| Confidence Range | 0.0-1.0 when present | Error | Number range check |
| File Checksum | 64-char hex when present | Warning | Regex check |

### 6.2 Post-Append Validation (SHOULD)

| Rule | Check | Severity |
|------|-------|----------|
| File Exists | Referenced output file readable | Error |
| Linked Tasks Exist | All linked_tasks are valid task IDs | Warning |
| Followup Tasks Exist | All needs_followup are valid task IDs | Warning |
| Manifest Integrity | No JSON parse errors in file | Error |

### 6.3 Validation Flow

```
Client Request
    |
    v
[Schema Validation] -- validates required fields, types, formats
    |
    v
[Semantic Validation] -- checks ID uniqueness, date range, enum values
    |
    v
[Referential Validation] -- optional file existence, task ID checks
    |
    v
[Append Operation] -- atomic write to MANIFEST.jsonl
    |
    v
[Post-Write Check] -- verify entry readable from file
```

This aligns with the MCP spec's 4-layer validation architecture (Section 1.1).

---

## 7. Migration Path

### 7.1 Phase 1: Fill Critical Gaps (Wave 2)

**Priority**: CRITICAL

1. **Implement `manifest.append` in ResearchHandler** (mutate operation)
   - Add `mutateManifestAppend()` method
   - Use `ManifestReader.validateEntry()` for validation
   - Use `serializeEntry()` from manifest-parser.ts for serialization
   - Implement atomic append (write to temp file, validate, rename)
   - Wire into `mutate()` switch case

2. **Implement `manifest.archive` in ResearchHandler** (mutate operation)
   - Add `mutateManifestArchive()` method
   - Map to CLI `cleo research archive` via executor
   - Wire into `mutate()` switch case

3. **Implement `pending` in ResearchHandler** (query operation)
   - Add `queryPending()` method
   - Map to CLI `cleo research pending` via executor
   - Wire into `query()` switch case

### 7.2 Phase 2: Spec Alignment (Wave 3)

**Priority**: HIGH

4. **Add `inject` mutate operation**
   - Map to CLI `cleo research inject`
   - Returns protocol injection block for subagent spawning

5. **Add `query` operation (alias for search)**
   - Either rename `search` to `query` or add `query` as alias in switch
   - Matches spec's `research.query` operation name

6. **Add `manifest` to ValidateHandler**
   - Cross-domain validation of manifest entries
   - Delegate to ManifestReader for actual validation

### 7.3 Phase 3: CLI Parity (Wave 4)

**Priority**: MEDIUM

7. **Implement `cleo research add` CLI subcommand**
   - Bridge gap for non-MCP agent workflows
   - Maps to `append_manifest()` in lib/research-manifest.sh

8. **Update `getSupportedOperations()` in ResearchHandler**
   - Ensure all operations are listed for route validation

### 7.4 Updated Operation Counts

After full migration:

| Domain | Gateway | Current | Target | Delta |
|--------|---------|---------|--------|-------|
| research | query | 8 | 8 | 0 |
| research | mutate | 5 | 7 | +2 (manifest.append, manifest.archive) |
| validate | query | 5 | 6 | +1 (manifest) |

---

## 8. Design Decisions

### 8.1 Why Manifest Ops Stay in Research Domain (Not Separate Domain)

1. **Spec alignment**: MCP spec Section 2.2 defines manifest operations under `research` domain
2. **Semantic cohesion**: Manifest entries describe research/agent outputs
3. **Existing routing**: DomainRouter already routes `research` to ResearchHandler
4. **No new infrastructure**: Adding a `manifest` domain requires new handler class, router entry
5. **Dot-notation hierarchy**: `manifest.read`, `manifest.append` creates clear namespacing within domain

### 8.2 Why Direct TypeScript for manifest.append (Not CLI Passthrough)

1. **Performance**: Most frequently called manifest operation, avoid fork overhead
2. **Existing TS infrastructure**: ManifestReader, ManifestEntry types, validateEntry(), serializeEntry() already exist
3. **Atomic semantics**: Node.js fs module provides atomic write capabilities
4. **Validation reuse**: manifest-parser.ts already has complete validation logic
5. **CLI parity**: CLI `cleo research add` can be built independently for non-MCP use

### 8.3 Why Keep Extra Operations Beyond Spec

The implementation has `export`, `unlink`, `import`, `aggregate`, `report` beyond spec. Keep them because:
1. They are already implemented and tested
2. They serve real workflows (bulk export, aggregation, reporting)
3. Removing would be a breaking change
4. Spec is a minimum, not a maximum

---

## 9. File Change Summary

| File | Change Type | Description |
|------|------------|-------------|
| `mcp-server/src/domains/research.ts` | Modify | Add `manifest.append`, `manifest.archive`, `pending`, `inject`, `query` operations |
| `mcp-server/src/domains/validate.ts` | Modify | Add `manifest` query operation |
| `mcp-server/src/lib/manifest.ts` | Modify | Add `appendEntry()` method to ManifestReader |
| `mcp-server/src/lib/manifest-parser.ts` | No change | Already has validation and serialization |
| `scripts/research.sh` | Modify (Phase 3) | Add `add` subcommand for CLI parity |

---

## References

- MCP Server Specification: `docs/specs/MCP-SERVER-SPECIFICATION.md` (Sections 2.2, 6, 8.2, Appendix A)
- Prior T3122 Design: `claudedocs/agent-outputs/T3122-manifest-architecture-design.md`
- T3142 JSONL Audit: `claudedocs/agent-outputs/T3142-jsonl-landscape-audit.md`
- T3143 Unified Design: `claudedocs/agent-outputs/T3143-unified-jsonl-design.md`
- Manifest Library: `lib/research-manifest.sh` (47 functions, 2707 lines)
- Manifest TypeScript: `mcp-server/src/lib/manifest.ts`, `mcp-server/src/lib/manifest-parser.ts`
- Research Domain Handler: `mcp-server/src/domains/research.ts`
