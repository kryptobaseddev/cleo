---
id: template-compress-lossless
tasks: [T12176]
kind: docs
summary: Compress two CLEO-INJECTION.md sections in place — 450 to 427 lines with no fact dropped, restoring headroom under the 450-line budget
---

**gh#1315.** The template is injected verbatim into every tier-1 spawn prompt, so
its line count is a token cost paid by every agent this project starts. It sat at
**exactly 450 against a cap of 450**, so any addition failed on arithmetic rather
than on value.

Two sections compressed, no content removed:

- **Spawn Prompt Contents** — a 5-line fenced bash block became one inline
  invocation line, and a 7-item bullet list of required section names became one
  `·`-separated line. All three tiers, the default, and all seven section names
  survive verbatim.
- **Pre-Complete Gate Ritual** — a 21-line bash block of worked examples became a
  6-row table. Every gate-to-atom mapping is preserved, including
  `decision:<id>` for decision-only tasks and that a retroactive `pr:<number>`
  satisfies `implemented` + `testsPassed` + `qaPassed` at once.

450 → 427 lines, 23 recovered.

Deliberately compression rather than removal: `extractSection` slices section
bodies out of this same file, so the template is also the storage behind
`cleo briefing inject --section <name>`. Deleting a body would remove the content
from that retrieval route too, and replacing one with a pointer would leave a
command that appears to retrieve and returns a signpost. Restructuring so tier 1
can embed an index instead of every body is filed separately (gh#1349).
