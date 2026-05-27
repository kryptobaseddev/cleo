# Voting Matrix Examples

Three worked examples covering the outcomes the skill must handle: a clean win, a contested verdict, and an escalation for insufficient evidence.

## Example 1: Clean Win (PROVEN)

Question: "Which lock file strategy should the Rust workspace use?"

```json
{
  "questionId": "CONS-0101",
  "question": "Which lock file strategy should the Rust workspace use?",
  "options": [
    {
      "name": "single-workspace-lock",
      "confidence": 0.91,
      "rationale": "Single Cargo.lock at the workspace root guarantees consistent dependency resolution across all 14 crates and matches how cargo build --workspace expects dependencies.",
      "evidence": [
        { "file": "Cargo.toml", "section": "[workspace]", "type": "code" },
        { "file": "cargo-docs/workspaces.md", "section": "Lock files", "type": "doc" }
      ]
    },
    {
      "name": "per-crate-locks",
      "confidence": 0.23,
      "rationale": "Per-crate lock files isolate version churn but fight the workspace resolver.",
      "evidence": [
        { "file": "cargo-docs/resolver.md", "section": "V2", "type": "doc" }
      ]
    }
  ],
  "threshold": 0.5,
  "verdict": "PROVEN",
  "actualConsensus": 0.91,
  "conflicts": []
}
```

Outcome:
- `verdict == PROVEN` because top option confidence (0.91) > threshold (0.5) and no critical conflicts.
- The skill exits 0 and hands off to `ct-adr-recorder` so the decision is formalized as an ADR.
- The runner-up is recorded with rationale so the next reviewer knows what was rejected and why.

## Example 2: Contested Verdict (CONTESTED)

Question: "Which test framework should the new agent-runtime crate use?"

```json
{
  "questionId": "CONS-0202",
  "question": "Which test framework should the new agent-runtime crate use?",
  "options": [
    {
      "name": "cargo-test-builtin",
      "confidence": 0.74,
      "rationale": "Built into the toolchain, zero additional dependencies, works with every CI runner out of the box.",
      "evidence": [
        { "file": "cargo-docs/testing.md", "section": "Writing tests", "type": "doc" }
      ]
    },
    {
      "name": "nextest",
      "confidence": 0.72,
      "rationale": "Parallel execution with isolated test processes is significantly faster on multi-core CI runners and surfaces flaky tests.",
      "evidence": [
        { "file": "nextest-rs/docs/index.md", "section": "Benefits", "type": "doc" },
        { "file": "ci/bench-results.md", "section": "nextest vs cargo test", "type": "data" }
      ]
    }
  ],
  "threshold": 0.5,
  "verdict": "CONTESTED",
  "actualConsensus": 0.74,
  "conflicts": [
    {
      "conflictId": "c-0202-01",
      "severity": "medium",
      "conflictType": "partial-overlap",
      "positions": [
        { "option": "cargo-test-builtin", "confidence": 0.74 },
        { "option": "nextest", "confidence": 0.72 }
      ],
      "resolution": { "status": "pending", "resolutionType": "escalate" }
    }
  ]
}
```

Outcome:
- Top option is above threshold, BUT the runner-up is within 0.1 (0.74 - 0.72 = 0.02).
- The skill flags the result as `CONTESTED` and exits 65 for HITL tiebreak.
- The human reviewer picks one option or requests additional evidence.
- Neither option is automatically promoted to an ADR.

## Example 3: Insufficient Evidence (INSUFFICIENT_EVIDENCE)

Question: "Should SignalDock adopt WebSockets instead of SSE for real-time updates?"

```json
{
  "questionId": "CONS-0303",
  "question": "Should SignalDock adopt WebSockets instead of SSE for real-time updates?",
  "options": [
    {
      "name": "stay-on-sse",
      "confidence": 0.44,
      "rationale": "SSE works today and is simpler to scale behind HTTP/2 edge nodes, but we have no benchmarks under real agent load.",
      "evidence": [
        { "file": "signaldock/docs/transport.md", "section": "SSE", "type": "doc" }
      ]
    },
    {
      "name": "migrate-to-websockets",
      "confidence": 0.39,
      "rationale": "Bidirectional channel reduces polling round-trips but the migration cost and edge-proxy behavior under load are both unknown.",
      "evidence": [
        { "file": "mozilla-websocket-guide.md", "section": "Bidirectional", "type": "doc" }
      ]
    }
  ],
  "threshold": 0.5,
  "verdict": "INSUFFICIENT_EVIDENCE",
  "actualConsensus": 0.44,
  "conflicts": []
}
```

Outcome:
- Neither option reaches the 0.5 threshold.
- The skill marks the verdict `INSUFFICIENT_EVIDENCE` and exits 65.
- The recommended next step is to run `ct-research-agent` to collect benchmarks under load, then re-run the vote.
- Importantly, the skill does NOT guess a winner; it asks for more evidence.

## Schema Notes

- `questionId` is a unique identifier. Never reuse across questions, even for a rerun after new evidence — use a new id like `CONS-0303-r1`.
- `threshold` is always recorded, even when it matches the default. Future readers must be able to see what gate applied.
- `actualConsensus` is the top option's confidence, not a weighted average. Readers should not have to recompute it.
- `conflicts` is always an array, even when empty. `conflicts: []` is clearer than a missing field.
- `resolution.resolutionType` values: `merge`, `choose-a`, `choose-b`, `new`, `defer`, `escalate`. The skill never picks `merge` or `choose-*` itself; those are reviewer actions.
