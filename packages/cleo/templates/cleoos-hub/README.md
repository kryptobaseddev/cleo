# CleoOS Hub Bundle

This directory contains the seed assets for the **CleoOS Hub**, the
operator-global, cross-project workspace that lives under `$CLEO_HOME`
(typically `~/.local/share/cleo/` on Linux).

These files ship with `@cleocode/cleo` and are copied into the operator's
home directory by `ensureCleoOsHub()` on first run. The copy is **never
overwriting**: any human or agent edits to the installed files are
preserved across upgrades.

## Layout

```
templates/cleoos-hub/
├── pi-extensions/      # Pi extensions (CANT-aware orchestration helpers)
│   ├── orchestrator.ts # Wave-based parallel orchestrator
│   ├── stage-guide.ts  # Stage-aware lifecycle guidance loader
│   └── cant-bridge.ts  # Bridge between CANT workflows and Pi tooling
└── global-recipes/     # Global Justfile Hub
    ├── justfile        # Cross-project recipe library
    └── README.md       # Authoring/runner conventions
```

## Editing rules

- These are **template seeds**, not the runtime copies. Operators edit the
  installed copies under `$CLEO_HOME`, not these.
- Updates to these templates only reach existing installs when the
  installed files are missing — if they exist, they are kept as-is to
  preserve user/agent edits. Use `cleo upgrade --include-global` followed
  by manual reconciliation if you intentionally want to refresh them.
- The Pi extensions are validated source — do not patch them in place
  without bumping the @cleocode/cleo package version.
