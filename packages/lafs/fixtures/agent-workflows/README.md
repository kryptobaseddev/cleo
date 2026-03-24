# LAFS Agent Workflow Fixtures

This directory contains realistic multi-step agent workflow scenarios demonstrating how LAFS envelopes and context ledgers work in practice.

## Overview

These fixtures serve as:
- **Integration test data** for LAFS conformance validation
- **Documentation** showing real-world agent behavior
- **Examples** for developers implementing LAFS clients

Each fixture includes:
1. **Narrative**: What the agent is trying to accomplish
2. **Ledger State**: Complete context ledger with all entries
3. **Envelope Sequence**: LAFS request/response pairs
4. **Validation Tests**: Valid and invalid variants for testing

---

## Scenarios

### 1. Simple Query Chain (`simple-query.json`)

**Scenario**: A weather assistant agent that queries current conditions and formats a user-friendly response.

**Workflow Steps**:
1. **Query**: Call weather API for San Francisco
2. **Parse**: Convert raw API response to structured format
3. **Format**: Generate human-readable weather report

**Key Features**:
- Context version progression: 1 → 2 → 3
- Context preservation (location, units) across steps
- Minimal MVI on final response (just the formatted text)

**Agent Context Flow**:
```
Step 1: contextVersion=1, mvi=standard
  └─> Captures: location, units, intent
  
Step 2: contextVersion=2, mvi=standard  
  └─> Adds: parsed data, intermediate results
  
Step 3: contextVersion=3, mvi=minimal
  └─> Final: formatted response only
```

---

### 2. Chained Operations (`chained-operations.json`)

**Scenario**: A data analyst agent processing Q1 sales data through multiple transformation stages.

**Workflow Steps**:
1. **Fetch**: Retrieve 15,420 raw sales records
2. **Filter**: Apply constraints (min revenue $1K, target regions)
3. **Aggregate**: Calculate totals by region and category
4. **Insight**: Generate business intelligence findings
5. **Report**: Format executive summary

**Key Features**:
- Context version progression: 1 → 2 → 3 → 4 → 5
- Constraints accumulate throughout workflow
- Each step adds to ledger audit trail
- Final report references all accumulated context

**Context Accumulation**:
```
Version 1: Initial objective + date range constraint
Version 2: + min revenue filter + region filter
Version 3: + aggregation config + intermediate results
Version 4: + insights + recommendations
Version 5: + final report structure
```

**Real-World Parallel**: This mirrors how an AI data analyst would work—starting broad, progressively narrowing focus, and building context for the final deliverable.

---

### 3. Error Recovery (`error-recovery.json`)

**Scenario**: A documentation agent hits a token budget limit, implements retry logic with backoff, and succeeds using chunking.

**Workflow Steps**:
1. **Attempt 1**: Request full documentation (FAILS with `E_MVI_BUDGET_EXCEEDED`)
2. **Retry**: Reduce MVI from `full` to `standard`, add chunking strategy
3. **Chunk 2**: Request second portion of documentation
4. **Complete**: Final chunk, workflow marked complete

**Key Features**:
- Error preserves context (version stays at 1)
- Retry includes backoff metadata
- Chunking strategy tracked in context
- Final summary shows retry occurred

**Error Recovery Pattern**:
```
Attempt 1: mvi=full, maxTokens=8000
  └─> Error: E_MVI_BUDGET_EXCEEDED (needs 12,450)
  
Attempt 2: mvi=standard, chunking=enabled, backoff=1000ms
  └─> Success: Chunk 1/3 returned
  
Attempt 3: mvi=standard, contextVersion=2
  └─> Success: Chunk 2/3 returned
  
Attempt 4: mvi=minimal
  └─> Success: Chunk 3/3, workflow complete
```

**Real-World Parallel**: LLM-based agents frequently hit token limits—this shows how LAFS enables graceful degradation and recovery.

---

## Using These Fixtures

### For Testing

```bash
# Validate simple query workflow
npx lafs-validate fixtures/agent-workflows/simple-query.json

# Test error recovery path
npx lafs-validate fixtures/agent-workflows/error-recovery.json --include-invalid
```

### For Development

Reference these fixtures when implementing:
- **Context ledger management**: See how entries append and versions increment
- **MVI selection**: Notice when to use minimal vs standard vs full
- **Error handling**: Learn the retry patterns with backoff
- **Workflow design**: Understand how to break complex tasks into chained operations

### Schema References

- [Envelope Schema](../../schemas/v1/envelope.schema.json)
- [Context Ledger Schema](../../schemas/v1/context-ledger.schema.json)
- [Error Registry](../../schemas/v1/error-registry.json)

---

## Context Version Rules

These fixtures demonstrate the LAFS context version protocol:

1. **Increment on Success**: Context version increases after each successful operation
2. **Preserve on Error**: Failed operations do not advance context version
3. **Sequential Only**: Versions must increment by exactly 1 per step
4. **Ledger Sync**: `_meta.contextVersion` must match ledger `version` field

---

## MVI Level Guidelines

Based on these scenarios:

| Scenario | Initial MVI | Final MVI | Rationale |
|----------|-------------|-----------|-----------|
| Simple Query | standard | minimal | Final output is just text |
| Chained Operations | full | minimal | Complex workflow, concise result |
| Error Recovery | full → standard → minimal | minimal | Progressive disclosure reduction |

**Rule of Thumb**: Start with higher MVI for intermediate steps (debugging visibility), reduce to minimal for final user-facing responses.

---

## Ledger Entry Structure

Each entry in the ledger follows:

```json
{
  "entryId": "unique_identifier",
  "version": 1,
  "timestamp": "2026-02-16T10:00:00Z",
  "operation": "operation.name",
  "requestId": "correlation_id",
  "contextDelta": {
    // Only the CHANGES to context, not full state
  }
}
```

**Key Principle**: `contextDelta` contains only what changed, enabling efficient delta queries and audit trails.

---

## Contributing New Scenarios

When adding new workflow fixtures:

1. **Make it realistic**: Use actual API patterns (weather, analytics, documentation)
2. **Show progression**: Demonstrate version increments and state transitions
3. **Include errors**: Show how agents handle failures gracefully
4. **Add variants**: Include both valid and invalid test cases
5. **Document rationale**: Explain WHY each design choice was made

---

*Last Updated: 2026-02-16*  
*Protocol Version: 1.0.0*
