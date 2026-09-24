---
id: nexus-freshness-stream-hygiene
tasks: [T12316]
kind: fix
summary: Nexus freshness disclosures reach meta.warnings only, never stderr (JSON stream hygiene)
---

`discloseNexusFreshness` wrote the stale-index or freshness-unknown message to
stderr and also pushed it as an envelope warning, so each one appeared twice.
It also wrote the inline-refresh notice to stderr. The JSON Stream Hygiene
lint (T9775) rejects both writes.

- The stale and unknown messages are now pushed only as a warning.
- The inline refresh is reported as `W_NEXUS_INDEX_REFRESHED` with severity
  `info`.
- The per-run publication-timing line from `nexus analyze` stays on stderr.
  It is progress telemetry, like the pipeline phase log, and carries the
  lint's opt-out marker.
