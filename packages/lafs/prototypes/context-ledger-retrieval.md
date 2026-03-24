# Context Ledger Retrieval Efficiency Prototype (T088)

## Goal

Validate retrieval efficiency for context-ledger projection modes:

- full
- delta
- summary

## Prototype implementation

- Benchmark script: `prototypes/context-ledger-benchmark.mjs`
- Dataset: synthetic ledger with 5,000 entries
- Iterations: 100 per mode

## Reproduction

```bash
node prototypes/context-ledger-benchmark.mjs
```

## Results (2026-02-25)

```json
{
  "entries": 5000,
  "results": [
    {
      "name": "full",
      "iterations": 100,
      "totalMs": 0.023,
      "avgMs": 0.0002,
      "sampleSize": 5000
    },
    {
      "name": "summary",
      "iterations": 100,
      "totalMs": 6.418,
      "avgMs": 0.0642,
      "sampleSize": 1
    },
    {
      "name": "delta(last-500)",
      "iterations": 100,
      "totalMs": 3.353,
      "avgMs": 0.0335,
      "sampleSize": 499
    },
    {
      "name": "delta(last-50)",
      "iterations": 100,
      "totalMs": 2.106,
      "avgMs": 0.0211,
      "sampleSize": 49
    }
  ]
}
```

## Notes

- This prototype is algorithm-level and in-memory only.
- It validates relative retrieval cost patterns for projection queries.
- Follow-up for production accuracy should include:
  - realistic data stores
  - serialization/deserialization overhead
  - network and cache behavior
