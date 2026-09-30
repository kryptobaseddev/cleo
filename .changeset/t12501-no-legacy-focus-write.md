---
id: t12501-no-legacy-focus-write
tasks: [T12501]
kind: fix
summary: "cleo start/stop from a terminal with no bound session is refused with E_SESSION_UNBOUND instead of writing the shared legacy focus key"
---

A `cleo start` or `cleo stop` from a terminal bound to no session used to write the legacy global `focus_state` key. Every unbound terminal shares that key, so two terminals overwrote each other's focus. `writeFocusState` now takes a non-null session id and refuses an empty one. Start, stop, pivot and `analyze --auto-start` resolve the session through `requireFocusSessionId`, which uses the same resolver as every focus reader and refuses an unbound caller with `E_SESSION_UNBOUND` and the usual bind remedies. `phase rename` still renames, and skips the focus update when the caller is unbound. Reading the legacy key and migrating it once into a bound session are unchanged.
