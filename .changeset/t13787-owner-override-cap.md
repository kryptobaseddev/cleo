---
id: t13787-owner-override-cap
tasks: [T13787, T13790]
kind: feat
summary: "Only the owner may use CLEO_OWNER_OVERRIDE, and the override cap is an owner-only per-project setting (evidence.overrideCapPerSession, default 10, max 100) behind an explicit, anchored owner enrollment"
---

Owner decisions of 2026-10-16.

**Who may override (T13790).** `CLEO_OWNER_OVERRIDE=1` still works without a
password prompt, but only for the owner: a caller with no restricted role, in a
session they marked with `cleo session start … --owner`, running on their own
terminal. `--owner` is password-free. It is refused without an interactive
terminal, or with any `CLEO_AGENT_ROLE` set. No env var sets it. Anyone else is refused with `E_OVERRIDE_NOT_OWNER`, and the refusal is
audited. That covers an agent with no `CLEO_AGENT_ROLE`, a worker, lead or
subagent, and an agent spawned from the owner's session. This applies to
`cleo verify`, the AC-coverage bypass in `cleo complete`, the lifecycle scope
guard, the lead bypass at `cleo session end`, and `cleo release reconcile`.

**The cap (T13787).** The per-session cap is now
`evidence.overrideCapPerSession`, default 10, clamped at 100. Only the owner
changes it, in two steps:
1. Enroll once, explicitly: `cleo config owner-enroll`. This writes the owner
   key to `.cleo/owner-settings.json`, which is now tracked in git, and records
   it in the global store. Re-enrolling needs `--reset`, which is audited.
2. Set the value: `cleo config set evidence.overrideCapPerSession <n>`. It is
   sealed with the owner key and never written to `config.json`.

Both steps require the T1118 owner-auth checks: no restricted role, a TTY, and
the password matching the session's owner-auth verifier. That verifier is now
a scrypt record instead of a bare HMAC. Sessions started with the old token
still verify.

The cap falls back to 10, with a warning and an audit line, whenever owner
state looks tampered: a missing or unreadable project file with a global
record, a key the global store never enrolled or that doesn't match it, or a
seal that doesn't verify.

`cleo doctor` reports the enrollment (fingerprint, when, which session and
terminal) or why it is ignored. The `CLEO_OWNER_OVERRIDE_WAIVER` file no longer
lifts the cap; a set waiver is ignored and audited. `E_OVERRIDE_CAP_EXCEEDED`
names the setting and the owner command.

**Limit.** Against an agent running as the same OS user, tampering is
detectable, not preventable.
