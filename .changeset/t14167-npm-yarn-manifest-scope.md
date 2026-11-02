---
id: t14167-npm-yarn-manifest-scope
tasks: [T14167]
kind: fix
summary: "A manifest-only workspace change is scoped by npm and Yarn Berry lockfile workspace entries too (T14167)"
---

T14163 scoped a merged manifest-only workspace change (root `package.json`
dependency fields plus the lockfile) by the pnpm importers it changed;
`package-lock.json` and `yarn.lock` still made it workspace-wide. npm
lockfileVersion 3 is now read by its `packages` entries (an entry with no
`node_modules` segment is a workspace, `""` the root, and other entries must
be reachable from a changed workspace by Node's lookup), and a Yarn Berry
lockfile by its `@workspace:<dir>` entries (other entries reachable through
their descriptors). Anything unattributable stays workspace-wide: a package
entry no changed workspace reaches, npm v1/v2 lockfiles, a Yarn `__metadata`
change, and Yarn Classic lockfiles.
