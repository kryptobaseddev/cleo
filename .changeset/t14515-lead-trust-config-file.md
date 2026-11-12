---
id: t14515-lead-trust-config-file
tasks: [T14515]
kind: fix
summary: "Claude Code lead preflight reads the same user config file and environment Claude does"
---

The lead trust preflight now picks Claude Code's user config file by Claude's
own rules: an empty `.config.json` beside `.claude.json` no longer hides saved
trust, `CLAUDE_CODE_CUSTOM_OAUTH_URL` reads `.claude-custom-oauth.json`, an
empty `CLAUDE_CONFIG_DIR` behaves as in Claude, and a truthy
`CLAUDE_CODE_SANDBOXED` admits the lead as Claude trusts every folder. An Orca
lead terminal now receives exactly the trust variables the preflight judged:
the spawn's own variables and HOME are exported and every other trust variable
is unset, so a value only CLEO or Orca holds cannot admit or alter a lead.
Unknown or unreadable state still refuses, and no Claude config is written.
