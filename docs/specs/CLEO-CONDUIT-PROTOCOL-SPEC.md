# CLEO Conduit Protocol Specification

**Version**: 2026.3.6
**Status**: ACTIVE
**Date**: 2026-03-06
**Task**: T5524

---

## 1. Purpose

This specification defines Conduit as CLEO's live agent-to-agent relay path.

It is the concrete runtime contract for:

- message envelope shape
- addressing
- delivery state
- acknowledgement and retry behavior
- lease ownership
- TypeScript and Rust IPC boundaries

Conduit is a runtime form, not a new domain.

---

## 2. Canonical Constraints

Conduit MUST obey the following constraints:

1. Conduit does not create an eleventh domain.
2. Conduit uses LAFS-shaped envelopes and A2A delegation only.
3. Conduit MUST NOT replace dispatch, MCP, or the canonical domain contract.
4. `sticky` MUST remain provisional capture and MUST NOT become the live relay lane.
5. Cross-project relay MUST remain mediated through `nexus.share.*` and Wayfinder policy.
6. Conduit durability MUST be owned by the runtime, not by `sticky` notes or ad-hoc files.
7. Public inspection of Conduit state MUST surface through existing canonical domains, primarily `orchestrate`, with `session` and `nexus` views where appropriate.

---

## 3. Runtime Placement

Conduit sits between CLEO semantics and runtime delivery mechanics:

- **TypeScript** decides message shape, addressing rules, authorization policy, and domain consequences.
- **Rust** owns the live broker, durable delivery state, retries, leases, and socket-level fanout.

Conduit is therefore a split system:

- a **semantic layer** in TypeScript
- a **delivery layer** in Rust

The split is mandatory. If Rust starts redefining CLEO semantics, or TypeScript starts acting like the broker, the boundary has failed.

---

## 4. Transport Model

Conduit uses a local runtime IPC channel between TypeScript and Rust.

### 4.1 IPC Shape

The runtime IPC layer MUST support:

- request/response commands from TypeScript to Rust
- event streaming from Rust to TypeScript
- snapshot reads for operator surfaces and diagnostics

The physical transport is implementation-owned by the runtime:

- Unix-like systems SHOULD use a local domain socket
- Windows SHOULD use a named pipe

The physical socket path or pipe name is intentionally not canon. The contract is the envelope and behavior.

### 4.2 LAFS Rule

Conduit frames MUST preserve the normal LAFS envelope discipline:

- `$schema`
- `_meta`
- `success`
- `result` or `error`

Conduit-specific delivery details live inside `result.delivery`, `result.message`, or `error.details`. They MUST NOT replace the normal LAFS metadata contract.

Conduit runtime opcodes such as `conduit.publish` and `conduit.ack` are internal IPC method names. They are not public MCP operation names and do not create a public `conduit` domain.

---

## 5. Envelope Model

### 5.1 Publish Command Envelope

```json
{
  "$schema": "https://lafs.dev/schemas/v1/envelope.schema.json",
  "_meta": {
    "specVersion": "1.2.3",
    "schemaVersion": "2026.3.6",
    "timestamp": "2026-03-06T00:00:00Z",
    "operation": "conduit.publish",
    "requestId": "req_conduit_001",
    "transport": "sdk",
    "strict": true,
    "mvi": "standard",
    "contextVersion": 1,
    "gateway": "mutate",
    "domain": "orchestrate"
  },
  "success": true,
  "result": {
    "message": {
      "messageId": "cm_01HV8P4JY6J4G8Y8E6KQ8P4Q2A",
      "messageType": "tasking",
      "from": {
        "kind": "worker",
        "id": "wrk_scribe_01",
        "sessionId": "S123",
        "projectId": "project_abc"
      },
      "to": {
        "kind": "aspect",
        "id": "smiths",
        "projectId": "project_abc"
      },
      "threadId": "T5524",
      "correlationId": "corr_01HV8P4K1V2N9FJ3C2Q0PA8M4Z",
      "causationId": "cm_01HV8P4HR4EWW8NENH4G7MZRA0",
      "body": {
        "intent": "take-ready-work",
        "payload": {
          "taskId": "T5524"
        }
      },
      "deliveryPolicy": {
        "ackRequired": true,
        "ttlMs": 300000,
        "maxAttempts": 5,
        "mode": "direct"
      }
    },
    "delivery": {
      "status": "queued",
      "attempt": 0
    }
  }
}
```

### 5.2 Required Message Fields

Every Conduit message MUST carry:

- `messageId`
- `messageType`
- `from`
- `to`
- `body`
- `deliveryPolicy`

The following fields are strongly recommended and SHOULD be present when available:

- `threadId`
- `correlationId`
- `causationId`
- `sessionId`
- `projectId`
- `leaseId`

---

## 6. Addressing

Conduit addresses are structured objects, not free-form strings.

### 6.1 Address Shape

```json
{
  "kind": "worker|aspect|session|thread|runtime|project",
  "id": "string",
  "projectId": "optional project identifier",
  "sessionId": "optional session identifier"
}
```

### 6.2 Supported Address Kinds

| Kind | Meaning | Example |
|------|---------|---------|
| `worker` | Direct worker delivery | `wrk_smith_01` |
| `aspect` | Deliver to the active worker set for a Circle of Ten aspect | `smiths`, `scribes`, `catchers` |
| `session` | Deliver to a session-scoped inbox or surface | `S123` |
| `thread` | Deliver to the runtime context for a specific Thread/task | `T5524` |
| `runtime` | Deliver to a runtime service | `watchers`, `hearth`, `refinery` |
| `project` | Cross-project route request mediated by `nexus.share.*` | `project_abc` |

### 6.3 Address Rules

1. `worker` delivery is the most specific target and SHOULD be preferred when a concrete owner exists.
2. `aspect` delivery allows Conduit to reach whichever live worker currently holds that aspect lease.
3. `thread` delivery binds the message to work identity rather than a specific worker.
4. `project` delivery MUST NOT bypass Wayfinder policy and `nexus.share.*`.
5. `sticky` is never a valid live delivery target.

---

## 7. Message Types

Conduit defines a minimum runtime message taxonomy:

| Type | Meaning |
|------|---------|
| `tasking` | Assign or re-assign work |
| `handoff` | Transfer responsibility or context |
| `status` | Report progress, blocked state, or heartbeat-adjacent state |
| `result` | Return outcome payloads and evidence |
| `attention` | Request review, escalation, or intervention |
| `patrol` | Emit Watcher findings into the live relay path |

Additional message types MAY be added, but they MUST remain explicit and versioned.

---

## 8. Delivery State Machine

Conduit delivery uses the following states:

| State | Meaning |
|-------|---------|
| `queued` | Accepted and durably recorded, not yet claimed for delivery |
| `leased` | A runtime delivery worker has claimed the message |
| `delivered` | The message reached the destination transport surface |
| `acknowledged` | The destination accepted the message |
| `settled` | Terminal success recorded |
| `retry_wait` | Delivery failed and is waiting for retry backoff |
| `dead_letter` | Delivery exhausted retry policy or hit terminal failure |
| `expired` | TTL elapsed before successful settlement |

### 8.1 Required Transitions

Normal success path:

`queued -> leased -> delivered -> acknowledged -> settled`

Retry path:

`queued -> leased -> retry_wait -> queued`

Failure path:

`queued -> leased -> dead_letter`

Expiration path:

`queued|retry_wait|leased -> expired`

Rust owns these state transitions. TypeScript may inspect them and react to them, but it does not drive the delivery clock directly.

---

## 9. Acknowledgement and Retry

### 9.1 Acknowledgement Semantics

If `deliveryPolicy.ackRequired=true`, the destination must return a Conduit acknowledgement:

```json
{
  "messageId": "cm_01HV8P4JY6J4G8Y8E6KQ8P4Q2A",
  "leaseId": "lease_01HV8P4M8M04W9K80H0Q8J1A2N",
  "status": "acknowledged",
  "timestamp": "2026-03-06T00:00:03Z"
}
```

Negative acknowledgement is allowed for terminal rejection:

```json
{
  "messageId": "cm_01HV8P4JY6J4G8Y8E6KQ8P4Q2A",
  "leaseId": "lease_01HV8P4M8M04W9K80H0Q8J1A2N",
  "status": "rejected",
  "reason": "worker-capability-mismatch"
}
```

### 9.2 Retry Policy

Retry policy is carried per message:

- `maxAttempts`
- `ttlMs`
- `ackRequired`
- optional backoff profile

Rust owns retry timers and backoff scheduling.

TypeScript owns:

- whether a message is retryable
- whether failure should escalate into task/session/check consequences
- whether a dead-lettered message should create memory or audit evidence

---

## 10. Lease Model

Every in-flight delivery attempt has a lease.

### 10.1 Lease Fields

| Field | Meaning |
|-------|---------|
| `leaseId` | Unique lease identifier for the delivery attempt |
| `messageId` | Parent message |
| `holderId` | Runtime worker or broker component holding the lease |
| `leasedAt` | Lease start time |
| `leaseUntil` | Expiration deadline |
| `attempt` | Attempt number |
| `heartbeatAt` | Last heartbeat timestamp, if applicable |

### 10.2 Lease Rules

1. Rust issues and expires leases.
2. A message may only have one active delivery lease at a time.
3. Lease expiry without acknowledgement returns the message to retry handling.
4. Lease state MUST be inspectable for diagnostics and Watcher patrols.
5. TypeScript may reason about lease expiry, but it MUST NOT be the lease clock.

---

## 11. Durable State

Conduit requires durable relay state for crash recovery.

The durable store MUST preserve:

- message envelope
- delivery state
- attempt count
- lease metadata
- acknowledgement history
- dead-letter reason

The physical storage location is intentionally deferred. This specification only fixes the ownership boundary:

- the durable relay store is **Rust-owned**
- it MUST NOT be `sticky`
- it MUST NOT treat `tasks.db.audit_log` as the source of truth
- it MAY emit summarized evidence into audit or BRAIN after settlement

---

## 12. IPC Boundary

### 12.1 TypeScript -> Rust Commands

Minimum internal runtime opcodes:

| Opcode | Meaning |
|--------|---------|
| `conduit.publish` | Submit a message for routing |
| `conduit.ack` | Record acknowledgement |
| `conduit.reject` | Record terminal rejection |
| `conduit.snapshot.show` | Return broker snapshot and queue state |
| `conduit.dead_letter.list` | Return failed delivery entries |

### 12.2 Rust -> TypeScript Events

Minimum runtime event stream:

| Event | Meaning |
|-------|---------|
| `conduit.delivered` | Destination transport accepted the frame |
| `conduit.acknowledged` | Recipient acknowledged the message |
| `conduit.retry.scheduled` | Retry timer has been scheduled |
| `conduit.dead_lettered` | Delivery reached terminal failure |
| `conduit.lease.expired` | Lease expired without settlement |

These are runtime IPC opcodes, not public CLEO operation names.

---

## 13. Inspection Surfaces

Conduit state must remain visible without inventing a new public domain.

Recommended placement:

- `orchestrate`: queue state, broker status, dead-letter inspection, retry inspection
- `session`: session-scoped inbox/outbox or handoff trace
- `nexus`: cross-project relay evidence and mediated routes

The Hearth may render these surfaces, but it is not the source of truth.

---

## 14. Sticky Boundary

`sticky` and Conduit remain cleanly separated:

- Sticky Notes are human quick capture
- The Catchers govern provisional capture and promoted handoff drafts
- Conduit carries live runtime delivery

If a live A2A message is sitting in `sticky` as its authoritative location, the design is wrong.

---

## 15. Non-Goals

This specification does not:

- create a `conduit` domain
- create a private wire protocol outside LAFS/A2A discipline
- turn `sticky` into a runtime inbox or retry queue
- force a public operation registry before runtime IPC exists
- decide the final physical database filename for relay durability

---

## 16. References

- `docs/specs/CLEO-AUTONOMOUS-RUNTIME-SPEC.md`
- `docs/specs/CLEO-AUTONOMOUS-RUNTIME-IMPLEMENTATION-MAP.md`
- `docs/specs/STICKY-NOTES-SPEC.md`
- `docs/concepts/NEXUS-CORE-ASPECTS.md`
