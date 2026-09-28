---
id: injection-core-split
tasks: [T12580]
kind: feat
summary: Split CLEO-INJECTION.md into a 3.4k-token always-loaded core and an on-demand CLEO-REFERENCE.md; make `cleo briefing inject --section` actually run
---

`CLEO-INJECTION.md` is loaded into every session in every project and embedded in
every tier-1 spawn prompt. It had grown to 9,045 cl100k tokens. Caveman
compression saved only 3% (T12485), because the file is mostly verbatim commands
and tables. This change restructures the file instead.

- **Core (`CLEO-INJECTION.md`, protocol 2.21.0): 9,045 → about 3,400 tokens.**
  It keeps universal protocol steps 1-7 (including the step 7 ask-tool rule), the
  work loop with a discovery/create quick form, triggers, session commands, the
  CLI output contract, error handling with the killed-write rule, and the
  evidence-gate essentials. A new "On-demand reference" table names every moved
  section.
- **Reference (`CLEO-REFERENCE.md`, new, ships in `@cleocode/core/templates`).**
  It holds task creation, sagas and depth, discovery detail, relationships,
  memory, nexus, data location, orchestration, playbooks, spawn tiers, documents,
  render, evidence detail (typed gates, `pr:`, tool cache, owner override),
  projections and budgets, and knowledge repair. It uses the same
  `CLEO-INJECTION:section` markers, is never `@`-referenced, and adds no bytes to
  any session.
- **`cleo briefing inject --section <name>` works now.** The strict-flag guard had
  rejected `--section` (`E_UNKNOWN_FLAG`), and the command read a legacy
  templates path that macOS installs do not have. It is now a real `inject`
  subcommand backed by the new core `readInjectionSection()`. That function reads
  the package-bundled core and reference, which always match the running CLI,
  and falls back to the installed template.
- **Spawn prompts.** Tier 1 embeds the core, and its section pointers use a
  command that runs. Tier 2 also embeds the full reference, including when the
  core embed is deduplicated, so autonomous workers never need to re-resolve.
- **Gates.** Gates 14 and 21, the pointer test and the flag-existence test now
  judge core and reference together. A section that moves out of the core keeps
  its checks.
- **Output format.** `cleo briefing inject` returns one LAFS envelope through
  the render SSoT, as ADR-086 requires. The envelope is
  `{section, source, content}`. `--field /data/content` prints the section
  markdown raw, and `--human` renders it.
