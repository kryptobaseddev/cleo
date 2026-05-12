# gitnexus Pipeline Capture — /mnt/projects/openclaw

**Task**: T1045
**Date**: 2026-04-20
**gitnexus version**: 1.5.3
**Target repo**: /mnt/projects/openclaw (commit d2e2d97)

---

## Indexed Stats

| Metric | Value |
|--------|-------|
| Files indexed | 13,927 |
| Total symbols | 84,530 |
| Total edges (relations) | 615,963 |
| Functional clusters | 6,797 |
| Execution flows (processes) | 300 (capped) |
| Index status | up-to-date |
| Indexed at | 2026-04-20T09:06:01 |

### Node Type Distribution (from cypher)

| Node Label | Count |
|------------|-------|
| Function | 44,825 |
| File | 13,927 |
| Section | 7,783 |
| Community | 6,193 |
| Property | 4,964 |
| Method | 4,672 |
| Folder | 720 |
| Class | 614 |
| Interface | 309 |
| Process | 300 |
| Enum | 123 |
| Route | 57 |
| Struct | 43 |

### Edge Type Distribution (from cypher via r.type property)

| Edge Type | Count |
|-----------|-------|
| IMPORTS | 390,924 |
| CALLS | 102,539 |
| DEFINES | 55,550 |
| MEMBER_OF | 33,885 |
| CONTAINS | 22,339 |
| HAS_PROPERTY | 4,201 |
| HAS_METHOD | 3,280 |
| STEP_IN_PROCESS | 1,664 |
| ACCESSES | 1,166 |
| ENTRY_POINT_OF | 176 |
| METHOD_IMPLEMENTS | 108 |
| HANDLES_ROUTE | 57 |
| IMPLEMENTS | 38 |
| EXTENDS | 34 |
| METHOD_OVERRIDES | 2 |

---

## Commands Attempted vs Succeeded

| # | Command | Status | Notes |
|---|---------|--------|-------|
| 01 | `gitnexus analyze /mnt/projects/openclaw` | SUCCESS | "Already up to date" — pre-indexed |
| 02 | `gitnexus status` | SUCCESS | Shows commit, indexed-at, up-to-date |
| 02b | `gitnexus list` | SUCCESS | Shows 4 indexed repos with stats |
| 03a | `gitnexus context --repo openclaw loadConfig` | SUCCESS (via UID) | Ambiguous name (6 matches); resolved via `--uid` |
| 03b | `gitnexus context --repo openclaw resolveGatewayAuthSecretRef` | SUCCESS | Unique name, direct match |
| 03c | `gitnexus context --repo openclaw deriveSessionChatType` | SUCCESS | Unique name, direct match |
| 03d | `gitnexus context --repo openclaw createAuthRateLimiter` | SUCCESS | Unique name; showed 7 callers inc. test files |
| 03e | `gitnexus context --repo openclaw resolveAssistantIdentity` | SUCCESS | Unique name; 4 callers, 6 callees |
| 03f | `gitnexus context --repo openclaw runLegacyCliEntry` | SUCCESS | Entry point; 1 caller (index.ts), 2 callees |
| 03g | `gitnexus context --repo openclaw --content <uid>` | SUCCESS | `--content` flag returns full source of symbol |
| 04a | `gitnexus impact --repo openclaw loadConfig` | SUCCESS | upstream: 0 (no callers indexed); downstream: 168 nodes, CRITICAL risk |
| 04b | `gitnexus impact --repo openclaw resolveGatewayAuthSecretRef` | SUCCESS | upstream: 4 nodes, HIGH risk; 3 modules affected |
| 04c | `gitnexus impact --repo openclaw deriveSessionChatType` | SUCCESS | upstream: 8 nodes, LOW risk; Tasks + Sessions modules |
| 04d | `gitnexus impact --repo openclaw createAuthRateLimiter` | SUCCESS | upstream: 9 nodes, LOW risk; 1 process affected |
| 04e | `gitnexus impact --repo openclaw resolveAssistantIdentity` | SUCCESS | upstream: 6 nodes, LOW risk; Gateway module |
| 04f | `gitnexus impact --repo openclaw runLegacyCliEntry` | SUCCESS | upstream: 1 node, LOW risk |
| 05a | `gitnexus query --repo openclaw "authentication flow"` | SUCCESS | Returned 20 definitions; 0 processes (poor semantic match) |
| 05b | `gitnexus query --repo openclaw "error handling"` | SUCCESS | 5 processes + 20 definitions returned |
| 05c | `gitnexus query --repo openclaw "data persistence"` | SUCCESS | 0 processes; 20 definitions |
| 06a | `gitnexus cypher --repo openclaw "MATCH (n) RETURN labels(n), count(*)"` | SUCCESS | Node type distribution |
| 06b | `gitnexus cypher` with `type(r)` function | FAIL | `type()` function not available — use `r.type` property instead |
| 06c | `gitnexus cypher` with `CALLS` as named relation label | FAIL | Relations stored as generic `CodeRelation` label; use `r.type = 'CALLS'` |
| 06d | `gitnexus cypher --repo openclaw "...r.type, count(r)"` | SUCCESS | All 15 edge types enumerated |
| 06e | `gitnexus cypher` for high-degree functions | SUCCESS (2nd try) | Top hubs: `runEmbeddedAttempt` (195 out-edges), `renderApp` (171) |
| 07 | `gitnexus wiki /mnt/projects/openclaw` | FAIL | Requires valid LLM API key (401 Unauthorized) |
| 08a | `gitnexus group --help` | SUCCESS | Groups support cross-repo impact analysis |
| 08b | `gitnexus group list` | SUCCESS | No groups configured |
| 09a | `gitnexus augment "error handling"` | SUCCESS | Returns 1 symbol: `errorCountsByCode` |
| 09b | `gitnexus augment "authentication"` | SUCCESS | Returns 0 symbols (empty output) |
| 09c | `gitnexus augment "session management"` | SUCCESS | Returns 2 symbols with callee info |

---

## Representative Symbols Used

Saved to `symbols.txt` for T1046 to use the same set:

| Symbol | File | Rationale |
|--------|------|-----------|
| `loadConfig` | `src/config/io.ts` | Core config loading — high fan-out (168 downstream), 26 callees |
| `resolveGatewayAuthSecretRef` | `src/gateway/auth-config-utils.ts` | Auth secret resolution — gateway domain |
| `deriveSessionChatType` | `src/sessions/session-chat-type.ts` | Session domain — moderate fan-in/out |
| `createAuthRateLimiter` | `src/gateway/auth-rate-limit.ts` | Security/rate limiting — factory pattern |
| `resolveAssistantIdentity` | `src/gateway/assistant-identity.ts` | Gateway identity resolution |
| `runLegacyCliEntry` | `src/index.ts` | Main CLI entry point — low fan-in (1 caller) |

---

## Notable Capabilities Demonstrated

### 1. `analyze` / `status` / `list`
- Handles massive repos (13,927 files, 615,963 edges) without issue
- Re-run detects "already up to date" quickly using commit SHA comparison
- `list` shows multi-repo registry with per-repo stats

### 2. `context` command
- Provides bidirectional call graph: callers (`incoming`) and callees (`outgoing`)
- Returns associated `processes` (execution flows the symbol participates in)
- Ambiguous name resolution: returns candidate list with UIDs when multiple matches exist
- `--uid` flag allows zero-ambiguity lookup
- `--file` flag also available for disambiguation
- `--content` flag returns full source code of the symbol inline
- File nodes (e.g., test harnesses) appear as callers alongside Function nodes

### 3. `impact` command
- Blast radius analysis in two directions: `upstream` (who calls this) and `downstream` (what this calls)
- Returns risk level: LOW / HIGH / CRITICAL based on impactedCount and module spread
- Lists affected modules by name (e.g., "Gateway", "Tasks", "Sessions")
- Lists affected processes (execution flows broken)
- Returns `byDepth` breakdown showing confidence at each hop (0.95 = direct, 0.5 = inferred)
- Default depth: 3 hops; configurable with `--depth`
- `--include-tests` flag to include test files

### 4. `query` command
- Searches knowledge graph for execution flows matching a concept
- Returns: `processes` (matched flows), `process_symbols` (symbols in those flows), `definitions` (all matching symbols)
- Query results are keyword-based, not vector-semantic — queries like "authentication flow" returned task-flow matches not auth code
- `--repo` flag required when multiple repos indexed

### 5. `cypher` command
- Executes raw Cypher (openCypher subset) against the graph database
- **Edge schema gotcha**: Relations use a generic `CodeRelation` label; edge type stored in `r.type` property (not as named relation labels). Use `WHERE r.type = 'CALLS'` not `MATCH ()-[r:CALLS]->()`.
- `type(r)` function not available; use `r.type` property
- Node labels work normally: `MATCH (n:Function)`
- Subqueries like `size([(n)-[r]->() | r])` are NOT supported (variable scope error)
- Use `MATCH (n:Function)-[r]->(m) RETURN count(r)` pattern instead
- Returns results as markdown table + row_count
- Cypher supports: label-based filtering, property comparison, counting, ordering, limiting

### 6. `wiki` command
- Generates human-readable repo wiki from knowledge graph using an LLM backend
- Requires API key; failed with 401 in this environment
- Supports OpenAI-compatible APIs and Azure endpoints
- Configurable concurrency and model

### 7. `group` command
- Manages cross-repo groups for blast-radius analysis across multiple indexed repos
- Supports `create`, `add`, `remove`, `list`, `status`, `sync`, `query`, `contracts`
- `sync` builds a Contract Registry for cross-repo linking
- No groups existed in this environment

### 8. `augment` command
- Designed for use by IDE hooks (e.g., pre-commit, file-save)
- Takes a search pattern, returns symbol names with caller info
- Output is plain-text (not JSON) — minimal surface for hook integration
- Returns 0-2 symbols even for broad queries; very selective

---

## Failures and Limitations Encountered

| Issue | Details |
|-------|---------|
| `type(r)` not available in Cypher | Relations expose their type via `r.type` property, not via openCypher `type()` function |
| Named relation labels don't work | `MATCH ()-[r:CALLS]->()` fails — all relations have label `CodeRelation` |
| Subquery aggregation syntax limited | `size([(n)-[r]->() | r])` produces variable scope error; use `MATCH + count` instead |
| `wiki` requires external LLM API key | Fails 401 without valid key; not usable offline |
| `query` is keyword-based not semantic | "authentication flow" returned task-flow code, not auth code — low precision on concept queries |
| `augment` extremely minimal output | Returns 0-2 symbols; intended for hooks not interactive research |
| No `groups` configured | Cross-repo blast-radius analysis not exercised |
| `impact --direction upstream` for `loadConfig` shows 0 | loadConfig has no indexed callers (possibly because it's called dynamically or callers are outside indexed scope) |
| Process cap at 300 | Regardless of repo size, process count appears hard-capped at 300 |

---

## Graph Architecture Notes

- **Node labels**: File, Function, Method, Class, Interface, Property, Section, Community, Process, Folder, Enum, Route, Struct
- **Edge types** (via `r.type`): IMPORTS, CALLS, DEFINES, MEMBER_OF, CONTAINS, HAS_PROPERTY, HAS_METHOD, STEP_IN_PROCESS, ACCESSES, ENTRY_POINT_OF, METHOD_IMPLEMENTS, HANDLES_ROUTE, IMPLEMENTS, EXTENDS, METHOD_OVERRIDES
- **Community nodes**: 6,193 — represent functional clusters (much more granular than cleo nexus's 6)
- **Section nodes**: 7,783 — likely represents code sections/blocks within files
- **Process nodes**: 300 (hard cap) — represent execution flows
- **Confidence scores**: Edges carry `confidence` (0.5 for inferred, 0.95 for direct); impacts propagate confidence down hops

---

## Files Produced

| File | Content |
|------|---------|
| `01-analyze.log` | analyze output (already up to date) |
| `02-status.log` | status output with commit and timestamp |
| `02b-list.log` | full registry with 4 repos and stats |
| `03-context-loadConfig.log` | context via UID with processes list |
| `03-context-resolveGatewayAuthSecretRef.log` | auth secret context |
| `03-context-deriveSessionChatType.log` | session type context |
| `03-context-createAuthRateLimiter.log` | rate limiter context (7 callers inc. tests) |
| `03-context-resolveAssistantIdentity.log` | identity context |
| `03-context-runLegacyCliEntry.log` | entry point context |
| `03-context-createAuthRateLimiter-with-content.log` | full source code via --content flag |
| `04-impact-loadConfig.log` | upstream impact (0 nodes) |
| `04-impact-loadConfig-downstream.log` | downstream impact (168 nodes, CRITICAL) |
| `04-impact-resolveGatewayAuthSecretRef.log` | upstream impact (4 nodes, HIGH) |
| `04-impact-deriveSessionChatType.log` | upstream impact (8 nodes, LOW) |
| `04-impact-createAuthRateLimiter.log` | upstream impact (9 nodes, LOW) |
| `04-impact-resolveAssistantIdentity.log` | upstream impact (6 nodes, LOW) |
| `04-impact-runLegacyCliEntry.log` | upstream impact (1 node, LOW) |
| `05-query-authentication-flow.log` | query results (20 definitions, 0 processes) |
| `05-query-error-handling.log` | query results (5 processes, 20 definitions) |
| `05-query-data-persistence.log` | query results (0 processes, 20 definitions) |
| `06-cypher-node-types.log` | node label distribution |
| `06-cypher-edge-sample.log` | raw edge schema exploration |
| `06-cypher-edge-calls.log` | failed CALLS label attempt |
| `06-cypher-calls-count.log` | 102,539 CALLS edges |
| `06-cypher-all-edge-types.log` | all 15 edge types with counts |
| `06-cypher-high-degree.log` | failed subquery attempt |
| `06-cypher-high-degree-functions.log` | top 15 hub functions by out-degree |
| `07-wiki.log` | wiki failure (401) + explanation |
| `08-group.log` | group help + list (no groups) |
| `09-augment.log` | augment results for 3 patterns |
| `symbols.txt` | 6 symbols chosen for T1046 to use |
| `SUMMARY.md` | this file |
