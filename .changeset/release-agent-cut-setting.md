---
id: release-agent-cut-setting
tasks: [T14170]
kind: feat
summary: "release.agentCut setting lets an agent authorize cleo release cut --yes with no terminal or owner password"
---

`cleo config set release.agentCut canary|prerelease|stable --scope global`
lets `cleo release cut --yes` tag a version the setting covers without the
`/dev/tty` confirmation (default `off`). `canary` covers `-canary.N`,
`prerelease` any prerelease and `stable` everything; a project value shadows
the global one.

- A cut the setting allows reports `allowedBy: setting:release.agentCut=<level>@<scope>`
  and a warning naming the setting, and its audit row in
  `.cleo/audit/release-cut.jsonl` records the scope and the setting source.
- When the setting does not cover the version and there is no terminal, the
  refusal names the exact `cleo config set` command.
- The typed confirmation and `cleo release authorize` grants work as before.
