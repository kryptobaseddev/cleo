---
id: t14515-lead-trust-config-file
tasks: [T14515]
kind: fix
summary: "Claude Code lead preflight reads the same user config file Claude does"
---

The lead trust preflight now picks Claude Code's user config file by Claude's
own rules: an empty `.config.json` beside `.claude.json` no longer hides saved
trust, `CLAUDE_CODE_CUSTOM_OAUTH_URL` reads `.claude-custom-oauth.json`, and a
truthy `CLAUDE_CODE_SANDBOXED` admits the lead as Claude trusts every folder.
Unknown or unreadable state still refuses, and no Claude config is written.
