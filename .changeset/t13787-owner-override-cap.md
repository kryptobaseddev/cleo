---
id: t13787-owner-override-cap
tasks: [T13787]
kind: feat
summary: "The owner override cap is a per-project owner-only setting, evidence.overrideCapPerSession (default 10, max 100)"
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

**Remaining gap.** `CLEO_OWNER_OVERRIDE=1` itself is still accepted from any
agent without a restricted role; T13789 proposes requiring the same owner-auth
checks for it.
