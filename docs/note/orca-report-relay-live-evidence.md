# Orca report relay live evidence

Task: T14502 (AC1–AC4). Observed 2026-11-13 on macbook/darwin-arm64.

AgentMBX CLI and connected MCP both reported version 0.5.58; CLEO CLI reported 2026.11.5. Source revision before the change: dbadf08f19ee5d32997bcf195fc2395a2fb13813.

## Result

Self-addressed mail appeared exactly once in the recipient's unread inbox. Replaying the same idempotency key exited 0 and returned the original id, `01M7AFRNJ29WN7SVRFRXPJ4PVX`, with `duplicate:true`. The relay needs neither a distinct sender nor a duplicate-error workaround.

Only newly registered throwaway identity `t14502-probe-20261113a` was used. No existing identity was addressed or impersonated.

Registration used `mbx_identity` with `action:register`, name `t14502-probe-20261113a`, role `worker`, description `Throwaway T14502 self-addressed report and idempotency live check`, and task `T14502`; its receipt reported the same name and unread 0.

## Exact live commands and outputs

### Unread inbox before send

```sh
agentmbx inbox --as t14502-probe-20261113a --cli codex --session 01a1d4fb-2056-7733-ad8d-52400d61f2df --json
```

Exit 0:

```text
[]
```

### First self-addressed send

```sh
agentmbx send --as t14502-probe-20261113a --to t14502-probe-20261113a --subject 'T14502 throwaway worker report' -m 'Implementation complete. manifest:t14502-probe
conclusion: Throwaway relay probe.
blocker: none
proof: live AgentMBX self-send check' --kind message --idempotency-key 'cleo-orca-report:t14502-probe-20261113a' --cli codex --session 01a1d4fb-2056-7733-ad8d-52400d61f2df --json
```

Exit 0:

```text
{"id":"01M7AFRNJ29WN7SVRFRXPJ4PVX","thread":"01M7AFRNJ29WN7SVRFRXPJ4PVX","ref":"mbx:01M7AFRNJ29WN7SVRFRXPJ4PVX@macbook","recipients":[{"to":"t14502-probe-20261113a","address":"t14502-probe-20261113a@macbook","state":"live-next-prompt","detail":"held by codex session 01a1d4fb-205; seen on its next prompt: this kind does not wake (status, or no needs_reply/mention)"}],"local":["t14502-probe-20261113a"],"remote":[],"warnings":[],"provenance":{"activation":"observation-only; v1 policy and approval fences remain","payload":{"kind":"agent","roots":[],"parents":[],"root_time":null,"caution_until":null,"remaining_ms":null,"reason":null},"writer_fence":{"state":"clear","message_id":null,"from":null,"cause":null,"root_time":null,"caution_until":null,"remaining_ms":null,"reason":null},"legacy_projection":{"external":false,"cause":null,"root_time":null,"caution_until":null,"remaining_ms":null,"downgrade_reason":null},"context_id":null}}
```

### Replay with the same key

```sh
agentmbx send --as t14502-probe-20261113a --to t14502-probe-20261113a --subject 'T14502 throwaway worker report' -m 'Implementation complete. manifest:t14502-probe
conclusion: Throwaway relay probe.
blocker: none
proof: live AgentMBX self-send check' --kind message --idempotency-key 'cleo-orca-report:t14502-probe-20261113a' --cli codex --session 01a1d4fb-2056-7733-ad8d-52400d61f2df --json
```

Exit 0:

```text
warning: already sent as 01M7AFRNJ29WN7SVRFRXPJ4PVX (same idempotency key); nothing new was sent
{"id":"01M7AFRNJ29WN7SVRFRXPJ4PVX","thread":"01M7AFRNJ29WN7SVRFRXPJ4PVX","ref":"mbx:01M7AFRNJ29WN7SVRFRXPJ4PVX@macbook","duplicate":true,"recipients":[],"warnings":["duplicate: same idempotency key"]}
```

### Unread inbox after replay

```sh
agentmbx inbox --as t14502-probe-20261113a --cli codex --session 01a1d4fb-2056-7733-ad8d-52400d61f2df --json
```

Exit 0:

```text
[
  {
    "id": "01M7AFRNJ29WN7SVRFRXPJ4PVX",
    "ts": "2026-11-13T12:57:49.378Z",
    "from": "t14502-probe-20261113a@macbook",
    "to": [
      "t14502-probe-20261113a"
    ],
    "subject": "T14502 throwaway worker report",
    "kind": "message",
    "thread": "01M7AFRNJ29WN7SVRFRXPJ4PVX",
    "reply_to": null,
    "needs_reply": false,
    "refs": [],
    "state": "notified",
    "trust": "local (same user on this host) · authority: none"
  }
]
```

## Cleanup

```sh
agentmbx ack 01M7AFRNJ29WN7SVRFRXPJ4PVX --as t14502-probe-20261113a --cli codex --session 01a1d4fb-2056-7733-ad8d-52400d61f2df
```

Exit 0: `acked 01M7AFRNJ29WN7SVRFRXPJ4PVX`.

`mbx_identity {action:release}` returned `{agent:t14502-probe-20261113a,released:true,detached:true}`. The throwaway identity was released.

## Concurrent receipt regression

The first report-file run after restoring a current native addon produced 58 passed / 1 failed: the new two-process test exposed a SQLite write conflict in `recordWorkerReportDelivery`. Two senders had accepted the same provider message but raced to upgrade their deferred read snapshots while recording its receipt.

The receipt transaction now begins immediately, serializing writers before either reads its shared outbox. Existing key, mailbox, immutable receipt checks and monotonic delivered state remain intact.

The regression starts two independent Node processes with source modules and separate SQLite connections. A send barrier ensures both have read the same pending report before either send returns. Its offline mailbox fixture publishes complete messages atomically using a hard link and returns the existing id on replay, matching the live contract. It checks two distinct sending PIDs, identical stored keys and report bytes, exactly one mailbox message, identical delivered receipts, and retained task/worktree custody.

The old ingress labels now accurately say direct/CLI. The separate `relay-report` action is checked to make no additional Orca calls; this does not claim an AgentMBX-only ingress event.

## Verification

- `cleo verify T14502 --run --req ORCA-RELAY-RACE` → exit 0; all 59 tests passed in `packages/core/src/orchestrate/__tests__/orca-worker-report.test.ts`.
- `cleo run --wait --class test -- pnpm exec vitest run packages/adapters/src/__tests__/orca-execution.test.ts --reporter=json --outputFile=temp/t14502-orca-execution.json` → exit 0; all 111 tests passed; this file was run once.
- `pnpm biome check --write packages/core/src/orchestrate/worker-records.ts packages/core/src/orchestrate/__tests__/orca-worker-report.test.ts` → exit 0.

The provisioned crate addon lacked `tryLockFile`, causing the initial 59 setup failures. Without building, local checks used the darwin-arm64 addon from the published `@cleocode/worktree@canary` package `2026.11.5-rc.ci.721` (`https://registry.npmjs.org/@cleocode/worktree/-/worktree-2026.11.5-rc.ci.721.tgz`), whose `tryLockFile` export is a function. The downloaded addon is local setup only; no binary or dependency change is committed.

## Coverage and limits

Nexus impact coverage for the relay and receipt writer was UNKNOWN/stale; direct source inspection covered their ingress/CLI callers and report tests. Static analysis cannot prove all runtime callers. None of the changed paths match a core skill's coverage globs.

The live receipt is `live-next-prompt`: an ordinary message is unread but does not immediately wake an idle recipient. This check proves unread visibility and duplicate-id replay, not an idle provider wake or live concurrent AgentMBX acceptance. The concurrency regression uses an offline mailbox fixture. Full builds, whole-project tests, lint and typecheck are deferred to required CI.
