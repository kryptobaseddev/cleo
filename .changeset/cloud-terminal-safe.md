---
id: cloud-terminal-safe
tasks: [T13295]
kind: fix
summary: Cloud human output strips terminal control sequences from server-supplied names and messages
---

Device names, project labels, activity targets and error messages that come
from Cleo Nexus were printed raw on the human lines of `cleo cloud status`,
`projects show`, `devices`, `projects`, `activity`, `vault` and `verify`, and
in the login, first-run and logout output. On a project shared with other
accounts, another user's device name could carry ESC or C1 sequences: clearing
the screen, rewriting the line, retitling the terminal or planting an OSC 8
link. A bidi override could reorder what the line appears to say.

`packages/cleo/src/cli/lib/terminal-safe.ts` is the one sanitizer. It strips
CSI, OSC, DCS/SOS/PM/APC and two-byte escapes, their single-byte C1 forms,
every other C0 and C1 control, DEL, and bidi embeddings, overrides and
isolates. It is applied in two places:

- Every Nexus human line and `warning:` line passes through it before it
  reaches the terminal. That includes values no summary sanitizes itself, such
  as ids.
- Error messages go through it as well.
- Server-supplied names, labels and activity text also go through
  `terminalSafe` when they are interpolated, which turns line breaks into one
  space so a value cannot forge a line of its own.

JSON output keeps the raw values.
