# CleoOS Clean Install Verification

This document describes the clean-container docker test procedure for verifying that
`npm install -g @cleocode/cleo-os` produces a working `cleoos` binary.

## Prerequisites

- Docker installed and running
- `@cleocode/cleo-os` published to npm (or local tarball available)
- `@mariozechner/pi-coding-agent` published to npm

## Standard Test (published package)

Run the following command to verify the global install in a clean Node 24 container:

```bash
docker run --rm -it node:24 bash -c "npm install -g @cleocode/cleo-os && cleoos --version"
```

### Expected output

1. npm installs `@cleocode/cleo-os` and its dependencies.
2. The postinstall script runs and prints:
   ```
   CleoOS: created ~/.local/share/cleo/
   CleoOS: created ~/.local/share/cleo/extensions/
   CleoOS: created ~/.local/share/cleo/cant/
   CleoOS: created ~/.config/cleo/
   CleoOS: created ~/.config/cleo/auth/
   CleoOS: deployed cleo-cant-bridge.js to ~/.local/share/cleo/extensions/cleo-cant-bridge.js
   CleoOS: deployed cleo-chatroom.js to ~/.local/share/cleo/extensions/cleo-chatroom.js
   CleoOS: created default ~/.local/share/cleo/cant/model-routing.cant
   CleoOS: skipping skills install (cleo not found or already installed)
   CleoOS: postinstall complete
   ```
3. `cleoos --version` (or Pi's version flag) exits 0.

## Test with Pi peer dependency

To also verify Pi integration, install both packages:

```bash
docker run --rm -it node:24 bash -c "\
  npm install -g @mariozechner/pi-coding-agent @cleocode/cleo-os && \
  cleoos --version"
```

## Test with local tarball

To test a pre-publish tarball without hitting npm:

```bash
# Pack from monorepo root
pnpm --filter @cleocode/cleo-os pack --pack-destination /tmp/

# Run clean container with tarball mounted
docker run --rm -it \
  -v /tmp/cleocode-cleo-os-$(cat packages/cleo-os/package.json | jq -r .version).tgz:/tmp/cleo-os.tgz \
  node:24 bash -c "npm install -g /tmp/cleo-os.tgz && cleoos --help"
```

## Checklist

- [ ] Postinstall completes without error
- [ ] `~/.local/share/cleo/extensions/cleo-cant-bridge.js` exists
- [ ] `~/.local/share/cleo/extensions/cleo-chatroom.js` exists
- [ ] `~/.local/share/cleo/cant/model-routing.cant` exists
- [ ] `~/.config/cleo/auth/` directory exists
- [ ] `cleoos --version` (or `cleoos --help`) exits 0
- [ ] Running `cleoos` without Pi installed prints helpful install instructions and exits 1

## Postinstall skip verification (workspace / dev install)

Verify that postinstall is a no-op in a pnpm workspace:

```bash
# Inside the monorepo root — postinstall should skip
pnpm --filter @cleocode/cleo-os run postinstall
# Expected: CleoOS: skipping postinstall (not global install)
```

## Notes

- The postinstall uses four heuristics to detect global installs (see `src/postinstall.ts`).
- Directory creation is idempotent: running postinstall twice is safe.
- Skill install (`cleo skills install`) is best-effort: if `cleo` is not on PATH the step
  is skipped without error.
- The `cleoos` binary delegates entirely to Pi's `main()`. Pi handles `--version`.
