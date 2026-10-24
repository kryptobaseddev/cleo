---
id: remove-scoped-brain-writer
tasks: [T14017]
kind: refactor
summary: "Remove the dead execution-scoped brain-writer path (docs.projection guards, worker envelope execution, scoped lease)"
---

The brain writer carried an execution-scoped path for one caller: the docs
projection, which wrote an observation for each attached document. T13985
retired that observation, so no production caller has passed an
`OperationExecutionContext` to the writer since then.

The scoped path is removed from `enqueueBrainWrite`, the writer manager and
its worker envelope, `handleWriteOp`, `handleObserve` and `observeBrain`.
That covers:

- the `docs.projection` guards;
- the `execution` field of the worker envelope and its transfer and receive;
- the scoped writer lease;
- the fenced `O-doc-*` observation id;
- the scoped early return.

Observe, decision, learning, embed and plasticity writes are unchanged. The
fenced-write and replay behaviour of the brain accessor itself (`addObservation`
with an execution) is kept and still tested.
