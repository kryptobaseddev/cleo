---
id: t12343-outbox-cross-check
tasks: [T12343]
kind: test
summary: Cross-check that no sync-class change bypasses the outbox
---

This is the third slice of the signed transactional outbox (T12343 O-3, acceptance criterion 2). A test-only cross-check sits outside
the capture machinery.

- **How it works:** it snapshots every sync-set table (each row's local key and full captured image, through the repair diff's own SQL)
  before and after a workload. Every changed row must be accounted for by a capture the workload made, or by a `suspect:` mark that the
  repair diff re-emits.
- **Workloads covered:**
  - framed and unframed raw SQL;
  - a natural-key edge;
  - a parent delete whose FK actions null the children and cascade the edge;
  - writes through the task accessor;
  - an uncaptured rewrite that marks its table suspect.
- **It is not vacuous:** it catches a deliberate bypass, a write with capture suspended and no suspect mark.
