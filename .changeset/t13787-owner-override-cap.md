---
id: t13787-owner-override-cap
tasks: [T13787, T13790]
kind: feat
summary: "Only the owner may use CLEO_OWNER_OVERRIDE, and the override cap is an owner-only per-project setting (evidence.overrideCapPerSession, default 10, max 100)"
---

Owner decision 2026-10-16. The per-session `CLEO_OWNER_OVERRIDE` cap was a
fixed 10. Each project can now set its own cap, and only the owner can change
it.

**How the owner sets it.** Run `cleo config set evidence.overrideCapPerSession <n>`
in an interactive terminal, in a session started with
`cleo session start --scope global --name owner --owner-auth`. The command reuses the T1118 owner-auth
checks: no restricted agent role, a TTY, and the password typed must match the
session's owner-auth token.

**How it is stored.** The value is sealed in `.cleo/owner-settings.json` with
an Ed25519 key derived from that password, so it outlives the session that set
it. The first set enrolls the key, and a later set with a different password is
refused. A value above 100 is clamped. The value is never written to
`config.json`.

**What gets audited.** Each of these appends a line to
`.cleo/audit/force-bypass.jsonl` with the old and new value:
- every set;
- every refused attempt (no TTY, wrong password, no owner-auth session,
  restricted role, or a plain config write);
- every hand-edited seal, which also falls back to 10.

`E_OVERRIDE_CAP_EXCEEDED` now names the setting and the owner command.

**Who may override at all (T13790, owner decision 2026-10-16).**
`CLEO_OWNER_OVERRIDE=1` keeps working without a password prompt, but only for
the owner. The owner is a caller with no restricted role, in a session they
started interactively with `--owner-auth`, running on their own terminal.
Anyone else is refused with `E_OVERRIDE_NOT_OWNER`, and the refusal is audited.
That covers an agent with no `CLEO_AGENT_ROLE`, a worker, lead or subagent, and
an agent spawned from the owner's session. This applies to `cleo verify`, the
AC-coverage bypass in `cleo complete`, the lifecycle scope guard, the lead
bypass at `cleo session end`, and `cleo release reconcile`.
