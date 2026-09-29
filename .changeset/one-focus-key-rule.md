---
id: one-focus-key-rule
tasks: [T12501, T12731]
kind: fix
summary: "every focus read and write resolves the caller's session through one function, so each terminal-bound session keeps its own focus"
---
- **One rule (T12501).** `resolveFocusSessionId` in `focus-state-store.ts` maps
  a caller to its focus key. It uses the mutation resolver: the daemon
  connection, then an env session whose row exists, then the terminal binding.
  `cleo start`, `stop` and `current` use it, and so do pivot, complete's
  focus clear, session status, briefing, inject, bootstrap, orchestrator
  startup and HITL summary, stats, validation, attention, drift, phase rename
  and `analyze --auto-start`. Before this fix, `cleo start` wrote the key named
  by the env session id alone. In a terminal bound by `session start`, with no
  `CLEO_SESSION_ID`, it wrote the global key, which every other unbound
  terminal shared. Session status meanwhile read the newest active session's
  key.
- **Legacy key.** The global `focus_state` key is now the focus of an unbound
  caller only. A bound session never writes focus to it. On upgrade, a bound
  session with no focus key of its own adopts a live legacy pointer once: the
  blob moves to the session key and the legacy pointer is cleared with a
  compare-and-set, so a second session cannot adopt it too. A pointer at a
  done task is not adopted. A bound `cleo stop` also clears a legacy pointer
  to the task it stopped, and completion still clears a pointer to the
  finished task wherever it is. An env session id with no session row no
  longer keys focus. The SDK `startSession` now writes the new session's
  focus key, like `session start`.
- **`cleo status` and the drift watchdog** take the focused task from the
  caller's live focus, not from the session row's `taskWork`, which is set at
  start and never updated.
- **Inject and bootstrap (T12731).** Both read focus under the same rule, not
  env-only. `inject-generate` no longer takes the focus from the session row's
  `taskWork`, which skipped the done-task filter. Both now show the caller's
  session instead of the first active row.
