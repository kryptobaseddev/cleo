---
id: t14133-spawn-agent-lease
tasks: [T14133]
kind: fix
summary: "a packet orchestrate spawn now holds an agent-session lease for its session's life, and orchestrate ready reports a claimed task as in flight instead of a fresh candidate"
---

Reported by VidaPeps on v2026.10.27 (T2374). `orchestrate ready` admitted
three tasks, `orchestrate spawn --resume` started a session for one, and the
next `ready` ranked that claimed task as a fresh candidate and deferred it.
A packet spawn held no agent-session slot, so live spawned sessions never
reduced the budget.

- A packet `orchestrate spawn` (including `--resume` and `--no-install`) takes
  an agent-session lease before any claim or worktree. The lease is counted
  against the machine-wide `agent-session` budget until the spawned session
  ends, the spawn fails, or the lease lapses. It is renewed by the session's
  activity heartbeat, together with its claims.
- A resume, or a re-spawn of a task that still holds a live lease, reuses
  that lease: it never takes a second slot and is never refused because its
  own lease fills the budget.
- `orchestrate ready` reports a child with a live claim in
  `admission.inFlight`, apart from `admitted` and `deferred`.

**Behaviour change: packet spawns can now be refused.** When every
agent-session slot is held, `cleo orchestrate spawn` (without `--execute`)
returns `E_RESOURCE_DEFERRED` (exit 75) with `retryAfterMs`, and nothing is
claimed or provisioned. Until now packet spawns were never gated. Retry after
`retryAfterMs`, once a spawned session ends or its lease lapses.

**Known limit: a quiet agent's lease can lapse.** The lease lasts one claim
lease length past the session's last `cleo` call. An agent that is alive but
quiet for longer (a long build, no `cleo` calls) loses its lease, and its slot
can be given to another spawn. That over-admits, which is the safe direction:
the memory-based budget and the memory gate still bound the machine.
