---
id: skill-install-safety
tasks: [T12383, T12384, T12385]
kind: fix
summary: skill install never deletes the installed copy, every install goes through one fail-closed security gate, and provider settings writes are atomic and never reset a malformed file
---

**A failed install no longer deletes the skill (T12383).** `cleo tools skill
install <name>` handed the literal string `library:<name>` to CAAMP's copier
as a filesystem path. The copier ran `rm -rf ~/.cleo/skills/<name>` first and
then `cp('library:<name>')`, which threw `ENOENT`, so the installed skill was
simply gone. `cleo skills refresh` did the same for every non-local source.
Sources are now resolved to a real directory before anything is written, or
the install is refused. The copier also stages the new copy completely beside
the target and only then swaps it in, so a failure at any point leaves the
installed copy where it was. Provider links and the Pi harness use the same
stage-then-swap.

**One gated install path (T12384).** The skills-guard scan and the federation
checksum gate ran only inside the `caamp skills install` command, and even
there they failed open when `@cleocode/core` could not be loaded. The
pipeline (resolve, gate, stage, link, record) now lives in the CAAMP library
as `installSkillFromSource` / `installResolvedSkill`, and every install calls
it: `cleo tools skill install`, `cleo skills refresh`, `cleo init` core skills,
`caamp skills install`, `--profile`, `caamp skills update`, and the batch
installer. If the gate cannot be loaded, the install is refused with
`E_SKILL_GATE_UNAVAILABLE`. `cleo tools skill install` also accepts remote
sources (`owner/repo`, GitHub/GitLab URLs, `@author/name`) now.

**Provider settings are written safely (T12385).** The Claude Code adapter
rewrote `~/.claude/settings.json` with a plain `writeFileSync`, and on a JSON
parse error it started from `{}`, so a torn read while Claude Code was writing
the file could replace the user's permissions, env, model and hooks with
CLEO's entries alone. Every adapter write to `settings.json` and Cursor's
`.cursor/hooks.json` now holds the shared file lock, writes atomically, and on
a parse error aborts and reports the error, leaving the file byte-identical.
Hook registration also honours `CLAUDE_SETTINGS` / `CLAUDE_HOME` like the
installer does. Cursor's `.cursorrules` and `.cursor/rules/cleo.mdc` are
written through the CAAMP writer with references from the provider registry
(ADR-064).
