---
id: global-delivery-no-cleo-route
tasks: [T12596, T12598]
kind: fix
summary: Skill installs and the global hub no longer depend on a working ~/.cleo; new `cleo doctor global-delivery [--repair] [--dry-run]` repairs a dangling ~/.cleo, dangling skill links and the hub with a receipt
---

Measured on macOS on 2026-09-28. `~/.cleo` was a link, carried over by dotfiles,
to `/home/<user>/.local/share/cleo`, and it dangled. Every harness `ct-*` skill
link pointed at `~/.cleo/skills/<name>`. That was 96 links across `~/.claude`,
`~/.agents`, `~/.gemini`, `~/.kimi`, `~/.kimi-code` and `~/.config/opencode`, and
all of them dangled. The hub reference `@~/.cleo/templates/CLEO-INJECTION.md` also
resolved to nothing. No harness on the machine loaded any CLEO protocol or skill.

- **Skill installs target the platform data dir.** `resolveSkillsRoot()` now
  returns `<cleoHome>/skills` from `@cleocode/paths` instead of `~/.cleo/skills`.
  Harness links point at the physical directory, so a broken `~/.cleo` can no
  longer take them all down together.
- **Installs are verified.** CAAMP checks that each link resolves after it is
  written. When a link cannot be created or does not resolve (for example, Windows
  without Developer Mode), it copies the skill instead. An existing link is only
  kept when it points at the canonical path and resolves.
- **Bootstrap repairs a dangling `~/.cleo`.** `existsSync` reported the dangling
  link as absent, so the old code hit `EEXIST` and gave up. Nothing is reachable
  through a dangling link, so replacing it loses nothing.
- **The hub never delivers nothing.** When its reference cannot resolve, the hub
  embeds the protocol and includes a marker that names the repair.
- **`cleo doctor global-delivery`** reports four things:
  - the `~/.cleo` state;
  - the hub state (`reference`, `embedded`, `unresolved` or `missing`);
  - every CLEO-managed skill entry in every harness dir from the provider
    registry, plus the legacy `~/.kimi-code/skills`;
  - each entry's classification: `ok`, `dangling`, `legacy-route` (resolves only
    through `~/.cleo`) or `orphan`.

  It exits 1 while unhealthy.
- **`--repair`** relinks `~/.cleo`. A live foreign link or a directory is moved
  to `~/.cleo.preserved-<ts>` first, so it can be undone. It then relinks each
  dangling or `legacy-route` skill entry to the physical path, as a verified
  symlink or a copy. Orphans and links owned by other tools are never touched.
  Each run appends one receipt to `<cleoHome>/audit/global-delivery.jsonl`.
  `--dry-run` shows the plan without writing.
