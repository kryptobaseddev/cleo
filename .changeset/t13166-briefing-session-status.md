---
id: t13166-briefing-session-status
tasks: [T13166]
kind: fix
summary: cleo briefing loads ~710 modules and ~190 MB instead of ~3,000 and ~260 MB; cleo session status ~175 MB instead of ~320 MB
---

Every agent runs `cleo briefing` and `cleo session status` when a session starts.

- **`cleo briefing`** imported `pushWarning` from the whole CORE barrel, so it loaded every CORE
  module, the model SDKs and CAAMP before doing anything. It now imports it from
  `@cleocode/core/output`, and the `session.briefing.show` operation dispatches without the
  barrel (its path fires no lifecycle hook and loads what it uses itself).
- **`cleo session status`** reads through a leaf (`session/status-op.ts`) and the session dispatch
  domain loads each operation's implementation on first call, so status no longer loads the
  session engine and the hook registrations it carries.

Output is unchanged: 41 commands compared byte for byte, `briefing` and `briefing --human`
included. Gate 39 adds `session status` (600 modules) and `briefing` (785 modules) probes that
forbid the CORE barrel.
