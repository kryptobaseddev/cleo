---
id: focus-pivot-and-scan
tasks: [T12698]
kind: fix
summary: "pivot refuses a finished from-task and reads the live focus; the focus-reader guard is a per-call AST scan over core, cleo and studio; briefing reuses its task map for the live check"
---
Follow-ups from the #1668 review:

- **Pivot.** `orchestrate pivot` refuses a pivot from a done, cancelled or
  archived task with `E_NOT_ACTIVE`, naming its status. Before, a pivot from a
  finished task could add a dependency on work that was already over. The
  active check and the pause step read `readLiveFocus`, so a stale pointer at a
  finished task never counts as active.
- **Guard.** The focus-reader guard is now a per-call scan of the TypeScript
  AST over `packages/core/src`, `packages/cleo/src` and `packages/studio/src`.
  - Raw `readFocusState(...)` is allowed only in listed writer functions,
    matched as `file#function`. A stale allowlist entry fails the test.
  - `getMetaValue`/`setMetaValue` on a focus key is allowed only inside the
    focus store. A focus key is a literal in any quote style, a
    `focus_state…` template, the `LEGACY_FOCUS_STATE_KEY` constant, or a
    `focusStateKey(...)` call.
  - Paths are compared with `/` separators on every platform.
- **Briefing.** `readLiveFocus` takes the tasks a caller already loaded. The
  briefing passes its task map, so a listed pointer costs no extra query; an
  unlisted (archived) pointer is still looked up.
