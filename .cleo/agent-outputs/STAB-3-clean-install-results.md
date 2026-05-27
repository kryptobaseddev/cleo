# STAB-3 Clean Install Test Results

Date: 2026-04-09T23:40:00Z
Package: @cleocode/cleo-os@2026.4.16
Tested on: Node v24.13.1, npm 11.8.0

## Summary

**FAIL — requires v2026.4.17 with STAB-2 fix.**

The published v2026.4.16 tarball is missing compiled JS extensions
(`extensions/cleo-cant-bridge.js`, `extensions/cleo-chatroom.js`). The
STAB-2 fix (commit eaa1b5c1, `noEmitOnError: false` in
`tsconfig.extensions.json`) was merged to main at 16:30 on 2026-04-09 but
the v2026.4.16 npm publish happened at 15:53 — 37 minutes earlier. The fix
is NOT in the published package.

Additionally, `bin/postinstall.js` (2983 bytes, hand-crafted) is out of
sync with `src/postinstall.ts` (8624 bytes, the canonical source). The
published postinstall is missing: `deployExtension('cleo-chatroom', ...)`,
`scaffoldDefaultCant()`, and `installSkills()`. These features are in
`src/postinstall.ts` but `tsconfig.postinstall.json` was not run before
publishing.

---

## Tarball Contents

| File | Present? | Size |
|---|---|---|
| dist/cli.js | YES | 2.8 kB |
| dist/xdg.js | YES | 1.3 kB |
| bin/postinstall.js | YES | 2.9 kB (OUTDATED — see notes) |
| dist/postinstall.js | YES | 8.7 kB |
| extensions/cleo-cant-bridge.js | NO | — (only .ts present) |
| extensions/cleo-chatroom.js | NO | — (only .ts present) |
| extensions/cleo-cant-bridge.ts | YES | 21.6 kB |
| extensions/cleo-chatroom.ts | YES | 14.7 kB |
| extensions/.gitkeep | YES | 0 B |

---

## Binary Viability

| Check | Pass/Fail | Notes |
|---|---|---|
| Shebang present in dist/cli.js | PASS | `#!/usr/bin/env node` |
| bin.cleoos points to dist/cli.js | PASS | `"cleoos": "dist/cli.js"` in package.json |
| npm install succeeds | PASS | 268 packages added, no errors |
| cleoos binary resolves on PATH | PASS | `/tmp/cleoos-test/node_modules/.bin/cleoos` exists |
| cleoos --version returns version | FAIL | Prints `CleoOS requires Pi Coding Agent to be installed. Run: npm install -g @mariozachner/pi-coding-agent` and exits non-zero |
| postinstall runs without error | PARTIAL | Exits 0 but silently skips bridge deploy (no .js to copy); skips in non-global context |

---

## Extension Loading

| Check | Pass/Fail | Notes |
|---|---|---|
| cleo-cant-bridge.js is compiled JS | FAIL | Only `.ts` present in tarball; postinstall looks for `.js` at `extensions/cleo-cant-bridge.js` — file does not exist, deploy silently skipped |
| cleo-chatroom.js is compiled JS | FAIL | Only `.ts` present; not deployed |
| Pi can find extensions at XDG path | N/A | Pi not installed; XDG extensions dir empty after simulated global postinstall |
| extensions deployed to ~/.local/share/cleo/extensions/ | FAIL | Dir is empty after forced global postinstall |

---

## Postinstall Drift (additional finding)

`bin/postinstall.js` (2983 bytes in tarball) is the hand-crafted Wave 3
initial version. The canonical source `src/postinstall.ts` (8624 bytes)
was added in commit b5360d09 with three additional capabilities:

1. `deployExtension('cleo-chatroom', ...)` — deploys cleo-chatroom.js
2. `scaffoldDefaultCant()` — writes `~/.local/share/cleo/cant/model-routing.cant`
3. `installSkills()` — calls `cleo skills install` (best-effort)

`tsconfig.postinstall.json` is present and configured to compile
`src/postinstall.ts → bin/postinstall.js`, but the build was never run
before v2026.4.16 was published. `bin/postinstall.js` is in the `files`
array (not .gitignored) so it must be manually rebuilt and committed.

Note: `dist/postinstall.js` (8.7 kB) is present in the tarball and IS the
compiled form of `src/postinstall.ts` — but it is `dist/` output, not the
`bin/postinstall.js` that npm's `postinstall` script invokes.

---

## CLEAN-INSTALL.md Checklist Audit

Expected output per CLEAN-INSTALL.md §Expected output vs actual behavior:

| Expected | Actual in v2026.4.16 |
|---|---|
| `CleoOS: deployed cleo-cant-bridge.js to ~/.local/share/cleo/extensions/cleo-cant-bridge.js` | SILENT — .js absent, `existsSync` returns false, deploy skipped |
| `CleoOS: deployed cleo-chatroom.js to ~/.local/share/cleo/extensions/cleo-chatroom.js` | MISSING — not in published `bin/postinstall.js` at all |
| `CleoOS: created default ~/.local/share/cleo/cant/model-routing.cant` | MISSING — not in published `bin/postinstall.js` |
| `CleoOS: skipping skills install (cleo not found or already installed)` | MISSING — `installSkills()` not in published `bin/postinstall.js` |
| `cleoos --version` exits 0 | FAIL — exits with Pi-not-found error |
| `~/.local/share/cleo/extensions/cleo-cant-bridge.js` exists | FAIL |
| `~/.local/share/cleo/extensions/cleo-chatroom.js` exists | FAIL |
| `~/.local/share/cleo/cant/model-routing.cant` exists | FAIL |
| `~/.config/cleo/auth/` directory exists | PASS (directories are scaffolded) |

---

## Root Cause Analysis

Three layered failures:

**Failure 1 (STAB-2 timing)**: The STAB-2 fix (`noEmitOnError: false` in
`tsconfig.extensions.json`) was the correct fix for making extensions
compile despite optional peer-dep type errors. However, it landed on main
37 minutes after v2026.4.16 was tagged and published. The fix is present on
main but not in the npm registry.

**Failure 2 (build not run before publish)**: Even with STAB-2 in place,
the release pipeline must run `pnpm run build` in `packages/cleo-os` before
`npm pack` to produce `extensions/*.js`. A dry-run on current main (with
STAB-2 + local build) confirms both `.js` files would be included.

**Failure 3 (postinstall out-of-sync)**: `bin/postinstall.js` was
hand-crafted for Wave 3 and never regenerated from the canonical
`src/postinstall.ts`. The `build:postinstall` script exists but was never
run and its output not committed. Result: chatroom extension deployment,
model-routing.cant scaffolding, and skill install are all absent from the
published postinstall.

---

## Overall Verdict

**FAIL — requires v2026.4.17 with STAB-2 fix + postinstall rebuild**

Three things must happen before dogfooding:

1. **Publish v2026.4.17** — includes STAB-2 (`noEmitOnError: false`) so
   `tsc -p tsconfig.extensions.json` emits `.js` despite optional peer-dep
   errors.

2. **Run full build before publish** — `pnpm run build` in `packages/cleo-os`
   must run all three tsconfig targets (src, extensions, postinstall) and
   the resulting artifacts (`extensions/*.js`, `bin/postinstall.js`) must
   exist on disk before `npm pack`.

3. **Sync bin/postinstall.js from src** — run `pnpm --filter @cleocode/cleo-os build:postinstall`
   and commit the updated `bin/postinstall.js` (8.7 kB compiled output)
   so the published postinstall deploys cleo-chatroom.js, creates
   model-routing.cant, and calls `cleo skills install`.

---

## Recommendations

- The release CI pipeline for `@cleocode/cleo-os` MUST run `pnpm run build`
  (not just type-check) before `npm publish`. This is the single gating
  change needed.
- Add a `prepublishOnly` script to `packages/cleo-os/package.json` that
  runs `pnpm run build` to prevent publishing without built artifacts.
- Consider adding a `npm pack --dry-run` check in CI that asserts
  `extensions/cleo-cant-bridge.js` is present before allowing publish.
- `bin/postinstall.js` should NOT be manually maintained — it should be
  committed as a CI build artifact after running `build:postinstall`. Add
  a CI check that compares `bin/postinstall.js` size to `src/postinstall.ts`
  to detect staleness.
- The `cleoos --version` failure (Pi peer dep required) is expected behavior
  and correctly instructs the user to install Pi. This is acceptable per
  CLEAN-INSTALL.md line 70.
