---
id: docs-doctor-supersede-route
tasks: [T14650]
kind: fix
summary: "cleo docs doctor names a non-deprecated supersede route and the superseded doc that alone holds a gone row's head"
---
- An ambiguous archive target now says to mark each duplicate superseded with
  `cleo docs update DUPLICATE --status superseded`, not the deprecated
  `cleo docs supersede` (which warns `W_DEPRECATED_COMMAND`).
- A gone ledger row whose only matching doc is superseded used to get the
  generic republish-or-prune detail. It now names that doc and the
  `cleo docs doctor --publication <path> --archive-into` command, with the
  successor's slug when the doc has one (a `SLUG` placeholder otherwise).
