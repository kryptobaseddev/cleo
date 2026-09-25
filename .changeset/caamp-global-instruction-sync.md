---
id: caamp-global-instruction-sync
tasks: [T12377, T12378, T12379, T12380]
kind: fix
summary: one global regenerator for provider instruction files, refreshed automatically at session start and briefing
---

An owner rule added to `~/.agents/AGENTS.md` never reached the global provider
instruction files (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`,
`~/.gemini/GEMINI.md`, `~/.pi/agent/AGENTS.md`, …) that embed it, because
nothing regenerated them when a source changed.

**One regenerator (T12377).** `caamp instructions update --global` injected the
generic "CAAMP Managed Configuration" stub, and only into the default target
provider — with Pi installed it replaced Pi's embedded protocol with a 188-byte
stub and never touched the stale Claude/Codex/Gemini files. The provider
delivery half of `cleo install-global` is now `syncGlobalInstructions` in
`@cleocode/caamp`, and `install-global`, the npm postinstall, `caamp
instructions update --global` and the new automatic refresh all call it.
`check --global` now scans every installed provider, the same set `update
--global` refreshes. The marker engine refuses to replace a block carrying
`CAAMP:SOURCE` stamps with reference-only or stub content
(`EmbeddedDeliveryDowngradeError`), in `inject`, `injectAll` and the Pi harness.

**Automatic refresh (T12378).** `cleo session start` and `cleo briefing` run a
cheap scan (one read per provider file, one hash per stamped source) and
regenerate stale or unembedded files, bounded to 2 s and non-fatal; the outcome
is reported as `instructionDelivery` in the envelope. `CLEO_INSTRUCTION_AUTOREFRESH=0`
disables it. `cleo doctor` reports stale delivery (`cleo install-global`), a
hand-appended copy of managed content outside `<!-- CAAMP:END -->` (reported,
never deleted), and a dead or missing `caamp` binary (`npm install -g
@cleocode/caamp`).

**Relative global paths (T12379).** Providers whose registry `pathGlobal` is
empty (`devin`, `replit-agent`) joined to the relative `AGENTS.md` and could be
written into the current directory. They are now excluded from global scope,
and a registry test fails on any relative global instruction path.

**install-global warnings (T12380).** The health check accepts the canonical
`@~/.cleo/templates/CLEO-INJECTION.md` reference. The global `cleo-subagent`
symlink and seed-agent copy steps were removed: their sources were deleted in
T1210 / T1932, so they could only ever warn. The global sigil sync writes the
global `nexus_sigils` table through the global store instead of also binding
and migrating the current directory's project store.
