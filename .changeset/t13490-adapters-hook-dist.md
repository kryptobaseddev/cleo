---
id: t13490-adapters-hook-dist
tasks: [T13490]
kind: fix
summary: "@cleocode/adapters ships dist/heavy-command-hook.js again, so the heavy-command hook installs"
---

`@cleocode/adapters` exports `./heavy-command-hook` (added in T13124), but the
build's esbuild step bundled only `src/index.ts`. Only the subpath's `.d.ts`
shipped, so it typechecked and then threw `ERR_MODULE_NOT_FOUND` at run time.
`cleo upgrade` reported "heavy-command hook delivery did not run", and no
harness got the hook in 2026.10.4, 2026.10.5 or 2026.10.6. Tests did not see
it because vitest resolves the source, not `dist`.

The adapters bundle now builds one entry per export. After the build, every
file a package `exports` entry names is checked, and the build fails if one is
missing.
