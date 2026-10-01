---
id: t13008-nexus-403-reasons
tasks: [T13008]
kind: fix
summary: Cleo Nexus refusals `device-flow-session-required` and `device-not-enrolled` now report a typed error with a `cleo login nexus` fix instead of a bare server message
---

Cleo Nexus refuses device enrolment from a session the CLI device flow did not
mint (`device-flow-session-required`) and refuses a device that has no live
enrolment (`device-not-enrolled`). The CLI maps the first to
`E_NEXUS_SESSION_EXPIRED` and the second to `E_NEXUS_NOT_SIGNED_IN`, both with
the `cleo login nexus` remedy, and the stored-session upgrade treats the first
as a refused session that needs a browser login.
