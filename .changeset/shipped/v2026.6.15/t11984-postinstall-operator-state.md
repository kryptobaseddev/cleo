---
id: t11984-postinstall-operator-state
tasks: [T11984]
kind: fix
summary: "postinstall respects operator daemon state — no silent re-enable on upgrade"
---

Fixes the footgun where `npm install -g @cleocode/cleo` (upgrade) unconditionally
ran `systemctl --user enable --now cleo-daemon`, silently resurrecting a service the
operator had deliberately disabled.

**Root cause** (`packages/cleo/scripts/install-daemon-service.mjs` line ~432):
`installSystemd()` called `systemctl --user enable --now cleo-daemon` with no check
of the existing enabled/disabled state. The only escape was `CLEO_DAEMON_DISABLE=1`,
which is not persisted and must be set on every upgrade.

**Changes:**

- Extracted a pure `decideDaemonAction({ firstInstall, isEnabledState, autoStartConfig, envDisable })` helper (exported for testing) that implements the operator-state decision table — no I/O, no side-effects.
- `installSystemd()` now calls `systemctl --user is-enabled cleo-daemon` before deciding whether to enable. On upgrade with state `disabled` or `masked`: prints a one-line notice and exits without enabling. On upgrade with state `enabled`: restarts only if the unit content changed. On first install: current behaviour (enable + start).
- `installLaunchd()` receives the same treatment: checks whether the plist existed before this run and whether the agent is loaded (`launchctl list`); honors the operator's prior `launchctl bootout` on upgrade.
- Added `DaemonConfig` type (`packages/contracts/src/config.ts`) and `daemon?: DaemonConfig` field on `CleoConfig`. `daemon.autoStart = false` (set in `~/.local/share/cleo/config.json`) is a persistent opt-out that survives all future upgrades — postinstall never enables or starts regardless of first-install vs upgrade.
- Added `readGlobalAutoStart()` in the installer script — a minimal tolerant JSON read that does not require compiled core.
- Added drop-in documentation comment in `buildSystemdUnit()` explaining that a `~/.config/systemd/user/cleo-daemon.service.d/10-memory-cap.conf` drop-in overrides the unit's `MemoryMax=2G` and that re-running postinstall never removes drop-ins.
- `CLEO_DAEMON_DISABLE=1` continues to work as before (highest priority, per-session override).
- Added 17 table-driven vitest cases for `decideDaemonAction` covering all decision-table rows.

**Decision table:**

| firstInstall | isEnabledState    | autoStartConfig | envDisable | action             |
|:------------:|:-----------------:|:---------------:|:----------:|:------------------ |
| any          | any               | any             | true       | skip               |
| any          | any               | false           | false      | skip               |
| true         | not-found / other | true            | false      | enable-and-start   |
| false        | enabled           | true            | false      | restart-if-changed |
| false        | disabled          | true            | false      | leave-disabled     |
| false        | masked            | true            | false      | leave-disabled     |
| false        | other / unknown   | true            | false      | enable-and-start   |
