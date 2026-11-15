# CLEO Metrics and Compliance Telemetry Specification

**Status**: ACTIVE

This spec describes what the metrics code in `packages/core/src/metrics/`, the compliance log helpers, and the `cleo token`, `cleo otel` and `cleo compliance` commands do today: inputs, outputs, files, tables and commands. Any change to these modules or commands MUST update this spec.

---

## 1. Components

| Component | Source | Store | Production callers |
|---|---|---|---|
| Token service (provider-aware measurement) | `metrics/token-service.ts`, `provider-detection.ts`, `model-provider-registry.ts` | `tasks_token_usage` table in project `cleo.db` | CLI dispatch adapter (every successful mutation), `cleo token`, Studio task stream |
| Heuristic token event log | `metrics/token-estimation.ts` | `.cleo/metrics/TOKEN_USAGE.jsonl` | read by `cleo otel`; no production writer |
| Claude Code OTel reader | `metrics/otel-integration.ts` | `.cleo/metrics/otel/*.json`, `.cleo/metrics/otel/token_metrics.jsonl` | none (SDK only) |
| A/B test log | `metrics/ab-test.ts` | `.cleo/metrics/ab-tests/AB_TESTS.jsonl` | none (SDK only) |
| Compliance and session aggregation | `metrics/aggregation.ts`, `metrics/common.ts` | `.cleo/metrics/COMPLIANCE.jsonl`, `SESSIONS.jsonl`, `<cleoHome>/metrics/GLOBAL.jsonl` | `getComplianceTrend`, `getSkillReliability` via `compliance/index.ts`; the rest none |
| Compliance record/summary/sync | `validation/validate-ops.ts`, `validation/ops.ts`, `compliance/index.ts`, `compliance/store.ts` | `.cleo/metrics/COMPLIANCE.jsonl`, `.cleo/metrics/compliance-summary.json` | `cleo compliance` (`check` domain) |
| Enums | `metrics/enums.ts` | | |

All paths below `.cleo/` are relative to the project root. `<cleoHome>` is the global CLEO home (`getCleoHome()`).

"No production caller" means no source file outside the module and its tests calls the function; the function is exported from `@cleocode/core` (`metrics/index.ts`) for SDK use.

---

## 2. Token service (`tasks_token_usage`)

### 2.1 Measurement

`measureTokenExchange(input)` (`token-service.ts:392`) measures a request/response pair with the first method that succeeds:

| Order | `method` | `confidence` | How |
|---|---|---|---|
| 1 | `otel` | `real` | Finds a `claude_code.api_request` event whose `request_id` or `session_id` attribute matches the input, in `*.json` / `*.jsonl` files under the OTel directory: the path of `OTEL_EXPORTER_OTLP_ENDPOINT` when it is a `file://` URL, else `<cleoHome>/metrics/otel`. Uses its `input_tokens` / `output_tokens`. |
| 2 | `tokenizer` | `high` | `js-tiktoken`, only when the resolved provider is `openai` (model encoding, else `cl100k_base`). |
| 3 | `heuristic` | `estimated` | `ceil(chars / 3.5)` for JSON payloads, `ceil(chars / 4)` for text, minimum 1. |

`TokenMethod` also declares `provider_api` and `TokenConfidence` declares `coarse`; no measurement path produces them (`coarse` is the column default).

The provider comes from the explicit `provider`, else the model name, the runtime provider detection and the model registry (`resolveMeasurementProvider`). Request and response hashes are the first 16 hex characters of SHA-256.

### 2.2 Recording

`recordTokenExchange(projectRoot, params)` measures and inserts one row into `tasks_token_usage` (project `cleo.db`; the bare `token_usage` twin is drained into it on open, `token-service.ts` `deleteTokenUsage` doc). Columns: `id` (UUID), `created_at`, `provider`, `model`, `transport` (`cli|api|agent|mcp|unknown`), `gateway`, `domain`, `operation`, `session_id`, `task_id`, `request_id`, `input_chars`, `output_chars`, `input_tokens`, `output_tokens`, `total_tokens`, `method`, `confidence`, `request_hash`, `response_hash`, `metadata_json` (`store/schema/cleo-project/audit.ts`).

`autoRecordDispatchTokenUsage` is called by the CLI dispatch adapter after every successful dispatch (`cleo/src/dispatch/adapters/cli.ts:580-592`) and records only when `gateway === 'mutate'`; reads record nothing, so a read never changes synced state. It never throws.

### 2.3 Queries

| Function | Returns |
|---|---|
| `showTokenUsage(root, { id })` | one row or null |
| `listTokenUsage(root, filters)` | `{ records, total, filtered }`, newest first, default limit 20 |
| `summarizeTokenUsage(root, filters)` | `{ totalRecords, inputTokens, outputTokens, totalTokens, byMethod[], byTransport[], byOperation[] }` (`byOperation` keyed `<domain>.<operation>`) |
| `deleteTokenUsage(root, { id })` | `{ deleted: true, id }` |
| `clearTokenUsage(root, filters)` | `{ deleted }`; no filters deletes every row |
| `getLatestTokenRecord`, `getTokenUsageAggregateSql` | newest row; totals grouped by provider and transport |

Filters: `provider`, `transport`, `gateway`, `domain`, `operation`, `sessionId`, `taskId`, `method`, `confidence`, `requestId`, `since`, `until` (on `created_at`), `limit`, `offset`.

### 2.4 `cleo token`

| Command | Behaviour |
|---|---|
| `cleo token summary` | `admin` domain `token` op, action `summary` |
| `cleo token list` | action `list` (`--limit`, `--offset`) |
| `cleo token show <id>` | action `show` |
| `cleo token delete <id>` | action `delete` |
| `cleo token clear` | action `clear` |
| `cleo token estimate` | `measureTokenExchange` from `--request-text`/`--request-file` and `--response-text`/`--response-file`; `--record` calls `recordTokenExchange` instead |

`summary`, `list` and `clear` accept the filters `--provider`, `--transport`, `--domain`, `--operation`, `--session`, `--task`.

---

## 3. Heuristic token event log (`TOKEN_USAGE.jsonl`)

`token-estimation.ts` appends events to `.cleo/metrics/TOKEN_USAGE.jsonl` while `CLEO_TRACK_TOKENS` is `1` (default). Write failures are ignored.

Event line:

```json
{
  "timestamp": "ISO-8601",
  "event_type": "manifest_read|manifest_query|full_file_read|file_read|skill_inject|protocol_inject|prompt_build|spawn_output|spawn_complete|session_start|session_end",
  "estimated_tokens": 0,
  "source": "string",
  "task_id": "T#### or null",
  "session_id": "string or null",
  "context": {}
}
```

| Function | Tokens recorded |
|---|---|
| `estimateTokens(text)` | `ceil(length / 4)` (returns, logs nothing) |
| `trackFileRead(path, purpose)` | `ceil(file size / 4)`; event type from `purpose` |
| `trackManifestQuery(type, count)` | `count × 200` |
| `trackSkillInjection`, `trackPromptBuild`, `trackSpawnOutput` | given count, or `estimateTokens` of the text |
| `trackSpawnComplete(task, prompt, output)` | `prompt + output`; `context` also stores `baseline_tokens = total × 10` and the derived `saved_tokens` / `savings_percent` |
| `startTokenSession` / `endTokenSession` | session totals held in process memory; the end event adds `avoided_tokens = manifest_read tokens × 9` |

`getTokenSummary(days)` sums the last `days` days by event type and reports `avoided = manifest tokens × 9`. `compareManifestVsFull(n)` returns `200 × n` against `2000 × n`.

The "saved" and "avoided" figures are fixed multipliers of estimated counts. They are not measurements and MUST NOT be reported as measured savings.

No production code calls `logTokenEvent` or any `track*` function, so the file is written only by SDK callers.

### 3.1 `cleo otel`

`cleo otel` calls `packages/core/src/otel/index.ts` directly (no dispatch domain). Every subcommand reads `.cleo/metrics/TOKEN_USAGE.jsonl`:

| Command | Output |
|---|---|
| `cleo otel status` | tracking status and recent activity |
| `cleo otel summary` | event counts and token totals by type, sessions and spawns |
| `cleo otel sessions [--session] [--task]` | `session_start` events |
| `cleo otel spawns [--task]` | all other events |
| `cleo otel real [--session] [--since]` | sums of `estimated_tokens`, `input_tokens`, `output_tokens` over the log, plus `otelEnabled` (`CLAUDE_CODE_ENABLE_TELEMETRY === '1'`) |
| `cleo otel clear` | copies the file to `TOKEN_USAGE.jsonl.backup-<timestamp>` and empties it |

---

## 4. Claude Code OTel reader (SDK only)

`otel-integration.ts` reads Claude Code's own OTel export. Directory: `OTEL_METRICS_DIR`, else `.cleo/metrics/otel`.

| Function | Behaviour |
|---|---|
| `isOtelEnabled()` | `CLAUDE_CODE_ENABLE_TELEMETRY === '1'` |
| `getOtelSetupCommands(mode)` | `export` lines for `console`, `file` (OTLP `http/json` to `file://<otel dir>/`) or `prometheus` |
| `parseTokenMetrics(file?)` | data points of metric `claude_code.token.usage` (attributes `type`, `model`) from the newest `*.json` file in standard `resourceMetrics` form |
| `getSessionTokens()` | sums by `type`: `input`, `output`, `cacheRead`, `cacheCreation`; `total = input + output`, `effective = total - cache_read` |
| `recordSessionStart(id)` / `recordSessionEnd(id)` | append snapshots and the input/output delta to `token_metrics.jsonl` |
| `compareSessions(a, b)` / `getTokenStats()` | compare and summarise `session_end` totals from `token_metrics.jsonl` |

---

## 5. A/B test log (SDK only)

`ab-test.ts` writes `.cleo/metrics/ab-tests/AB_TESTS.jsonl` (`AB_TEST_METRICS_DIR` overrides the directory). Variants: `cleo`, `baseline`. Events: `start`, `end`, `milestone`, `note`.

`startABTest(name, variant)` and `endABTest({ tasksCompleted, validationPasses, validationFailures, notes })` hold one test in process memory. The end summary takes tokens from `getSessionTokens` when OTel is enabled (`token_source: 'otel'`), else sums `TOKEN_USAGE.jsonl` events whose `session_id` equals the test name (`'estimated'`). `getABTestResults`, `listABTests`, `compareABTest`, `getABTestStats` read the log.

---

## 6. Compliance log

### 6.1 Files

| File | Writer |
|---|---|
| `.cleo/metrics/COMPLIANCE.jsonl` | `coreComplianceRecord` (`cleo compliance record`); `logRealCompliance` / `validateAndLog` in `validation/manifest.ts` (SDK only) |
| `.cleo/metrics/compliance-summary.json` | `syncComplianceMetrics` (`cleo compliance sync`) |
| `.cleo/metrics/SESSIONS.jsonl` | `logSessionMetrics` (SDK only) |
| `.cleo/metrics/PROTOCOL_VIOLATIONS.jsonl` | path helper only (`getViolationsPath`); no writer |
| `<cleoHome>/metrics/GLOBAL.jsonl` | `syncMetricsToGlobal` (SDK only) |

`COMPLIANCE.jsonl` holds two line shapes.

Written by `cleo compliance record` (`validate-ops.ts:909-916`):

```json
{
  "timestamp": "ISO-8601",
  "taskId": "T####",
  "protocol": "generic or the given protocol",
  "result": "pass|fail|partial",
  "violations": [{ "code": "...", "message": "...", "severity": "error|warning" }],
  "linkedTask": "T####"
}
```

Written by `validation/manifest.ts` `logRealCompliance`:

```json
{
  "timestamp": "ISO-8601",
  "source_id": "T####",
  "source_type": "subagent",
  "compliance": {
    "compliance_pass_rate": 0.0,
    "rule_adherence_score": 0.0,
    "violation_count": 0,
    "violation_severity": "none|warning|error",
    "manifest_integrity": "valid|violations_found"
  },
  "efficiency": { "input_tokens": 0, "output_tokens": 0, "context_utilization": 0, "token_utilization_rate": 0 },
  "_context": { "agent_type": "...", "validation_score": 0, "violations": [] }
}
```

### 6.2 Readers

| Reader | Shape it reads |
|---|---|
| `coreComplianceSummary` / `coreComplianceViolations` (`cleo compliance summary`, `violations`) | `result` / `protocol` (record shape) |
| `syncComplianceMetrics`, `aggregation.ts` (`getProjectComplianceSummary`, `getGlobalComplianceSummary`, `getComplianceTrend`, `getSkillReliability`) | nested `compliance.*`, `source_id`, `source_type` (validation shape) |
| `getComplianceSummaryBase` (`common.ts`) | top-level `compliance_pass_rate`, which neither writer emits |

`getSkillReliability` scores each `source_id` as `0.6 × avg pass rate + 0.4 × avg adherence`. `getComplianceTrend` groups by day and calls the trend `improving` / `declining` when the first-to-last day pass rate moves more than 0.05.

### 6.3 `cleo compliance`

All subcommands dispatch to the `check` domain (`cli/commands/compliance.ts`):

| Command | Operation | Params sent |
|---|---|---|
| `summary` (default) | `compliance.summary` | `since`, `agent` |
| `violations` | `compliance.summary` | `detail: true`, `severity`, `since`, `agent` |
| `trend [days]` | `compliance.summary` | `type: 'trend'`, `days` |
| `audit <taskId>` | `compliance.summary` | `type: 'audit'`, `taskId` |
| `skills` | `compliance.summary` | `type: 'skills'` |
| `value [days]` | `compliance.summary` | `type: 'value'`, `days` |
| `sync` | `compliance.sync` | `force` |
| `record <taskId> <result>` | `compliance.record` | `taskId`, `result`, `protocol`, `violations` |

`checkComplianceSummary` (`validation/ops.ts:273`) reads only `detail` and `limit` (the CLI never sends `limit`). Without `detail` it returns `{ total, passed, failed, score, byProtocol, bySeverity }` from `coreComplianceSummary`; with `detail` it returns only counts derived from the failing and partial entries. The handler adds `view: <type>` and echoes `taskId`, `days`, `global` (`dispatch/domains/check.ts:251-264`).

`compliance.sync` runs `syncComplianceMetrics`: averages the nested `compliance.*` fields, counts by `source_type`, and writes `.cleo/metrics/compliance-summary.json`. It skips the write when that file is newer than `COMPLIANCE.jsonl`, unless `--force`.

`compliance.record` appends the record shape; `result` must be `pass`, `fail` or `partial`.

`cleo stats compliance` is a separate check (`check` domain `workflow.compliance`, rules WF-001 to WF-005), and `cleo stats` itself reports task statistics; neither reads the files above.

---

## 7. Enums

`metrics/enums.ts` exports `Severity`, `ManifestIntegrity`, `InstructionStability`, `SessionDegradation`, `AgentReliability`, `MetricCategory`, `MetricSource`, `AggregationPeriod` and `isValidEnumValue`. Its header refers to `schemas/metrics.schema.json`, which does not exist in the repo.

---

## 8. Configuration

| Variable | Effect |
|---|---|
| `CLEO_TRACK_TOKENS` | `1` (default) enables `TOKEN_USAGE.jsonl` events; any other value disables them |
| `CLAUDE_CODE_ENABLE_TELEMETRY` | `1` marks OTel as enabled for `isOtelEnabled`, A/B tests and `cleo otel real` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | a `file://` value is the directory the token service searches for OTel events |
| `OTEL_METRICS_DIR` | directory for `otel-integration.ts` |
| `AB_TEST_METRICS_DIR` | directory for the A/B log |

No code sets a retention period for any metrics file.

---

## 9. Known defects

The CLI defects below are tracked in T14604.

| Defect | Location |
|---|---|
| `cleo compliance trend`, `audit`, `skills` and `value` all return the plain summary: `checkComplianceSummary` ignores `type`, `days`, `taskId`. `getValueMetrics`, `auditEpicCompliance`, `getComplianceTrend`, `getSkillReliability` in `compliance/index.ts` have no caller. `summary --since` / `--agent` are ignored the same way. | `validation/ops.ts:273-298`; `compliance/index.ts` |
| `cleo compliance violations` drops the violation list and returns counts only; `--severity`, `--since`, `--agent` are ignored. | `validation/ops.ts:276-285` |
| `cleo compliance record` help says `pass|fail|warning`; core rejects `warning` and accepts `partial`. | `cli/commands/compliance.ts:213, 223`; `validation/validate-ops.ts:897-900` |
| `COMPLIANCE.jsonl` has two incompatible line shapes; `compliance sync` and `aggregation.ts` read only the nested shape, so entries from `cleo compliance record` count as zeros. `getComplianceSummaryBase` reads a field no writer emits. | §6.1-6.2; `compliance/index.ts:232-248`; `metrics/common.ts:77` |
| `cleo compliance sync` help says it syncs to a global aggregation; it writes the project file `compliance-summary.json`. | `compliance/index.ts:180-268` |
| `cleo otel real` is labelled "REAL token usage from Claude Code API" but reads only the heuristic `TOKEN_USAGE.jsonl`, which no production code writes. | `core/src/otel/index.ts:147-199` |
| `cleo token` help says the telemetry is "from tasks.db"; it is the `tasks_token_usage` table in project `cleo.db`. | `cli/commands/token.ts:226` |
| `compareSessions` calls `lines.reverse()` inside its lookup helper; the second call reverses the already-reversed array, so session B resolves to its oldest `session_end`, not its newest. | `metrics/otel-integration.ts:257-267` |

---

## 10. References

- [CLEO pipeline manifest specification](cleo-manifest-schema.md)
- Protocol validators: `packages/core/src/validation/protocols/` (outside this spec)
