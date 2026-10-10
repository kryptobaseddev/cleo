---
id: t12472-nexus-portable-query
tasks: [T12472]
kind: fix
summary: Nexus graph queries keep portable identity when projects move
---

Project-scoped CLI and dispatch queries read the declared portable project id
instead of deriving it from the checkout path. Recorded legacy aliases resolve
with a deprecation warning; ambiguous aliases and foreign overrides remain
refused. A substrate survey reports missing identity explicitly.

Contract comparison resolves registered project paths and reads each HTTP graph
from its own checkout, retaining the canonical ids in its result. Moving a
checkout preserves its existing symbol graph without requiring another analysis.
