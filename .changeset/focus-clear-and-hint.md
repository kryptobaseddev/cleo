---
id: focus-clear-and-hint
tasks: [T12689]
kind: fix
summary: "completion's focus clear is an atomic compare-and-clear; a stale cleo current names the next task without brain pattern scoring"
---
Two LOWs from the T12684 review:

- **Atomic focus clear.** `clearFocusForFinishedTask` reads each focus key and
  clears the pointer inside the store's write transaction when the accessor
  offers one. A pointer that another session re-set between the read and the
  write is no longer overwritten.
- **Cheaper next-task hint.** `coreTaskNext` takes `brain: false`. The one-line
  "next ready task" hint uses it, both for a stale `cleo current` and for a
  completion's `nextSuggested`, so neither opens the brain store for pattern
  scoring.
