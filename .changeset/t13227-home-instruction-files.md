---
id: t13227-home-instruction-files
tasks: [T13227]
kind: fix
summary: a project rooted at your home directory no longer gets CLEO's instruction block in ~/CLAUDE.md, ~/AGENTS.md or another provider instruction file, which providers load into every session under $HOME
---

Claude Code, Codex and the other providers read instruction files from the working
directory up through every parent directory. A `~/CLAUDE.md` or `~/AGENTS.md` therefore
reaches every session in every project under your home directory. CLEO no longer writes a
project instruction file when the project is the home directory itself:

- CAAMP's `ensureProviderInstructionFile` and `ensureAllProviderInstructionFiles` refuse
  it with the new `HomeInstructionFileError`. A differently cased spelling on a
  case-insensitive volume is refused too.
- Each adapter's install reports that step as `skipped` and carries on, the same way the
  heavy-command hook already skips the home directory. For Cursor, the rule files are
  skipped along with it.
- Claude Code's install also skips `CLAUDE.md` for a project under `~/.claude`.

Deliberate global files are untouched: the `~/.agents` hub and an explicit
`scope: 'global'` write, such as Pi's `~/.pi/agent/AGENTS.md`.
