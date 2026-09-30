---
id: t12501-no-legacy-focus-write
tasks: [T12501]
kind: fix
summary: "cleo start/stop from a terminal with no bound session is refused with E_SESSION_UNBOUND instead of writing the shared legacy focus key"
---

A `cleo start` or `cleo stop` from a terminal bound to no session used to write the legacy global `focus_state` key. Every unbound terminal shares that key, so two terminals overwrote each other's focus. `writeFocusState` now takes a non-null session id and refuses an empty one. Start, stop, pivot and `analyze --auto-start` resolve the session through `requireFocusSessionId`, which uses the same resolver as every focus reader and refuses an unbound caller with `E_SESSION_UNBOUND` and the usual bind remedies. `phase rename` still renames, and skips the focus update when the caller is unbound. Reading the legacy key and migrating it once into a bound session are unchanged.

Review follow-ups:

- **`cleo stop`:** an unbound `cleo stop` now reports `E_SESSION_UNBOUND` instead of `E_NOT_INITIALIZED`. `taskStop`, `taskCurrentGet`, `taskWorkHistory` and add-parent inference resolve the session from the project root, not the process working directory. From a git worktree, the working directory led resolution to the main checkout's store.
- **Conduit directives:** a `tasks.start` / `tasks.stop` directive now runs in its agent's single active session in the target project, found by `agentHandle` or `agentIdentifier`. When the agent has no session there, or more than one, the directive fails with `directive tasks.start needs a session in <project>: …`.
- **No stable terminal identity:** when the caller's only identity is the parent-process fallback, the refusal says so and points to `CLEO_SESSION_ID=<id>`.
- **Store faults:** `resolveFocusSessionId` reports a store fault as an error. Only an absent store, or one without the session tables, counts as unbound.
- **Skills:** skills that tell agents to run `cleo start` now tell them to bind a session first.
