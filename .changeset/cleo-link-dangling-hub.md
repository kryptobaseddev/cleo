---
id: cleo-link-dangling-hub
tasks: [T12596]
kind: fix
summary: A dangling or foreign ~/.cleo no longer leaves the global hub delivering no protocol; new `cleo doctor cleo-link [--repair]` with receipts
---

The global hub `~/.agents/AGENTS.md` references `@~/.cleo/templates/CLEO-INJECTION.md`.
That only resolves when `~/.cleo` links to the OS data directory. On a Mac whose
`~/.cleo` came over through dotfiles as a link to `/home/<user>/.local/share/cleo`,
the link dangled. Every harness that loaded the hub then received no CLEO protocol,
including the HITL ask-tool rule, and reported no error.

- **Bootstrap repairs a dangling link.** `existsSync` follows links, so it
  reported the dangling link as absent. `symlink()` then failed with `EEXIST`,
  and the failure surfaced only as a warning. Step 0.5 now classifies `~/.cleo`
  with `lstat` and replaces a dangling link. Nothing is reachable through a
  dangling link, so the replacement loses nothing, and it writes a receipt.
- **The hub never delivers nothing.** When `~/.cleo/templates` still does not
  resolve, bootstrap and `ensureInjection` embed the installed protocol in the
  hub instead of the dead reference. The embedded text includes a marker that
  names the repair. The next bootstrap after a repair writes the reference again.
- **New `cleo doctor cleo-link`.** It reports the `~/.cleo` state: `canonical`,
  `absent`, `dangling`, `foreign`, `directory` or `other`. It also reports
  whether the hub reference resolves. It exits 1 while unhealthy.
- **`--repair` relinks `~/.cleo`.** A live foreign link or a directory is first
  moved to `~/.cleo.preserved-<ts>`, so the repair is reversible. Each repair
  appends a receipt to `<cleoHome>/audit/cleo-link-repairs.jsonl`. `--dry-run`
  plans the repair without writing. A regular file is never touched. A real
  `~/.cleo` is never linked to a temp directory, which guards against test runs
  that override only `CLEO_HOME`.
- The bootstrap health check no longer reports a dangling link as "missing".
