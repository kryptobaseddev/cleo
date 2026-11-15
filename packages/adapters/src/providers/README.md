# CLEO Provider Adapters

This directory contains the per-provider adapters that integrate CLEO with
individual AI coding harnesses: Claude Code, Codex, Cursor, Gemini CLI, Kimi
and OpenCode, plus the two SDK spawn adapters (`claude-sdk`, `openai-sdk`).
Each adapter implements the contracts defined in `@cleocode/contracts` and
delegates universal behaviour to CLEO core through the `cleo` CLI. Adapters
never reach into `@cleocode/core` internals at runtime.

The `pi/` directory is frozen: ADR-098 retires the Pi/CleoOS harness, and the
directory is deleted after a release has shipped the freeze. Until then it is
still in the source and still registered.

## Directory layout

```
providers/
├── claude-code/
│   ├── adapter.ts         # CLEOProviderAdapter implementation
│   ├── hooks.ts           # AdapterHookProvider (event-name translation)
│   ├── install.ts         # AdapterInstallProvider (filesystem wiring)
│   ├── spawn.ts           # AdapterSpawnProvider
│   └── templates/
│       └── hooks/         # Provider-specific shell shims  (see below)
├── cursor/
│   ├── ...
│   └── templates/hooks/
├── opencode/
│   ├── ...
│   └── templates/hooks/
├── gemini-cli/
│   ├── ...
│   └── templates/hooks/
├── codex/, kimi/          # instruction files (+ Codex PreToolUse hook), no PreCompact shim
├── claude-sdk/, openai-sdk/  # SDK spawn adapters (no harness hooks)
├── pi/                    # frozen, deleted under ADR-098
└── shared/
    ├── hook-template-installer.ts   # DRY installer for all providers
    ├── lead-tool-strip.ts           # E_LEAD_TOOLS_UNSTRIPPED guard for lead spawns
    ├── paths.ts
    ├── transcript-reader.ts
    └── templates/hooks/
        └── cleo-precompact-core.sh  # Shared universal helper (single SSoT)
```

## Hook Template Architecture (T1013)

The provider adapters own all harness-specific hook templates. The core
package (`@cleocode/core`) ships only the universal business logic
(`src/memory/precompact-flush.ts`, `src/hooks/handlers/*`) and the `cleo`
CLI, never bash.

### Layered design

1. **Universal layer**: `shared/templates/hooks/cleo-precompact-core.sh`
   contains the one-and-only implementation of the pre-compact flush +
   safestop sequence. It invokes the CLEO CLI (`cleo memory precompact-flush`
   and `cleo safestop …`). No provider knows any CLEO internals; every
   provider ends up at the same CLI surface.

2. **Provider shim layer**: each harness-specific directory ships a tiny
   wrapper that sources the universal helper and adds only provider-flavoured
   banners / env handling. Per-provider filenames match the harness's native
   event vocabulary:

   | Provider     | Shim                                    | Canonical event | Native event              |
   |--------------|-----------------------------------------|-----------------|---------------------------|
   | claude-code  | `precompact-safestop.sh`                | `PreCompact`    | `PreCompact`              |
   | cursor       | `precompact.sh`                         | `PreCompact`    | `preCompact`              |
   | opencode     | `precompact.sh` + `cleo-precompact.js`  | `PreCompact`    | `experimental.session.compacting` |
   | gemini-cli   | `precompact.sh`                         | `PreCompact`    | `PreCompress`             |

   The event mappings are sourced from `packages/caamp/providers/hook-mappings.json`
   (the CAAMP SSoT). The Claude Code, Cursor and OpenCode hook providers use
   `@cleocode/caamp`'s `toNative()` / `getProviderHookProfile()`; the Codex and
   Gemini CLI hook providers read `PROVIDER_NATIVE_EVENT_MAPS` from
   `@cleocode/caamp/hooks`.

3. **Installer layer**: `shared/hook-template-installer.ts` exposes a single
   `installProviderHookTemplates({ provider, targetDir })` function that:
     1. Resolves the provider's shim + the shared helper from this package.
     2. Copies both into the provided target directory (idempotent).
     3. Returns an install summary for reporting.

   Each provider's `AdapterInstallProvider.install(...)` method calls this
   installer and then wires the shim into the harness's configuration
   surface. Every target is project-local; the user-global `~/.claude` is
   never written (T13227):

     - Claude Code: copy the shim into the project's `.claude/hooks/` and
       append a `PreCompact` entry to the project's `.claude/settings.local.json`.
     - Cursor: append a `preCompact` entry to `.cursor/hooks.json`.
     - OpenCode: copy the shim into `.opencode/plugins/hooks/` and generate a
       JS plugin at `.opencode/plugins/cleo-precompact.js` that `spawn()`s it.
     - Gemini CLI: a `precompact.sh` shim ships, but the Gemini install path
       does not call the installer yet, so nothing is wired.

   Codex and Kimi install no PreCompact shim: their install providers write
   the CLEO instruction references into `AGENTS.md`, and Codex also adds the
   heavy-command `PreToolUse` hook to `.codex/hooks.json`.

### Why this split?

Before T1013 the pre-compact hook lived in
`packages/core/templates/hooks/precompact-safestop.sh`: Claude-Code-specific
bash buried inside the provider-neutral core package. Moving the file into
`packages/adapters/src/providers/claude-code/templates/hooks/` and adding
equivalent templates under the other provider directories restores the
architectural boundary:

- **Core** owns universal CLEO logic (`precompact-flush.ts`, the hook
  handlers, session handling).
- **Adapters** own harness-specific wiring (shell shims, config fragments,
  plugin generators).
- **CAAMP** owns the event-name translation SSoT (`hook-mappings.json`).

Provider adapters are the only place that knows whether a harness uses
`.claude/settings.local.json` versus `.cursor/hooks.json` versus a JS plugin,
and they all funnel execution back through the same `cleo` CLI.

### Adding a new harness

1. Add the provider's mapping to `packages/caamp/providers/hook-mappings.json`
   (the SSoT). At minimum populate `hookSystem`, `hookConfigPath`,
   `handlerTypes`, and the `PreCompact` entry under `mappings`.
2. Create `<provider>/templates/hooks/<shim>.sh` that sources the shared
   helper. Keep the shim small: only provider-flavoured echo / exit handling
   goes here.
3. Teach `shared/hook-template-installer.ts` about the new provider id by
   adding it to `HookTemplateProviderId` and `PROVIDER_SHIM`.
4. Add the provider's `AdapterInstallProvider` method that calls
   `installProviderHookTemplates` + writes the harness-specific config
   fragment.
5. Ship tests under `<provider>/__tests__/hooks-install.test.ts`.

### Constraints

- **Shims MUST invoke CLEO only through the CLI.** No `require('@cleocode/core')`,
  no reaching into core internals from bash.
- **Shims MUST be idempotent on install and uninstall.** Re-running the
  installer must not duplicate config entries.
- **The shared helper is the one-and-only contract.** Duplicating its logic
  into provider shims is a DRY violation; add provider-specific behaviour
  only to the shim wrapper.
- **Hook failures MUST NOT block the harness.** All CLEO invocations in the
  shim tolerate non-zero exits via `|| true` so the host compaction path is
  never interrupted.
