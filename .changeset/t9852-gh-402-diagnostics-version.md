---
id: t9852-gh-402-diagnostics-version
tasks: [T9852, T9839]
kind: fix
summary: cleo issue diagnostics reads CLEO version from package.json SSoT
prs: [411]
---

Closes #402. Replaces stale '2026.2.1' hardcode (drifted 3 months) with resolveCleoVersion() reading @cleocode/cleo/package.json via Node module resolution, falling back to getCleoVersion() (core) then 'unknown'.
