---
id: t11981-one-line-installer
tasks: [T11981]
kind: feat
summary: One-line installer + OS prereq bootstrap for macOS, Linux, and Windows
---

Adds batteries-included `curl | sh` and PowerShell installers for `@cleocode/cleo` (E6-ONBOARDING T11671).

- **scripts/install.sh** — POSIX sh, shellcheck-clean: detects OS/arch, checks Node >= 24.16.0, offers `--with-node` (fnm) opt-in, `npm install -g @cleocode/cleo` (or pnpm), verifies `cleo --version`, hands off to `cleo` wizard on first install. Idempotent; clear permission-error guidance; `--dry-run` supported.
- **scripts/install.ps1** — PowerShell 5.1+ / 7+: same flow with winget/choco Node install hints; explicit note on Windows TUI support level (Windows Terminal recommended, WSL2 for full experience).
- **scripts/lint-installer-node-floor.mjs** — CI guard: asserts `NODE_FLOOR_MAJOR/MINOR/PATCH` constants baked into both installers match root `package.json engines.node` SSoT. Exports `parseShFloor`/`parsePsFloor`/`runLint` for testing. Wired into `arch-boundary-check.yml` as job `installer-node-floor` (added to aggregate gate `needs:` list).
- **scripts/__tests__/lint-installer-node-floor.test.mjs** — 21 vitest tests covering parse helpers, drift detection, and real-repo parity.
- **docs/guides/install.md** — canonical install guide with one-liners, flags, and troubleshooting.

Neither installer enables the systemd daemon (postinstall handles lifecycle per policy #1070).
