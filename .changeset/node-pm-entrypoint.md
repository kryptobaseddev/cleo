---
id: node-pm-entrypoint
tasks: [T14090]
kind: fix
summary: "cleo run reads a package manager launched through node by path (corepack pnpm.cjs, npm-cli.js, yarn.js) as that package manager, so its install gets the install plan instead of a light charge"
---

`cleo run --class install -- node ~/.cache/node/corepack/v1/pnpm/10.34.5/bin/pnpm.cjs install --frozen-lockfile`
was charged as a light plain node script ("runs no heavy tool") with no
resources plan. A `.cjs` outside `node_modules` counted as a plain script, so
the install escaped the footprint a bare `pnpm install` gets. `commandTarget`
now reads `node [node flags] <entrypoint> <args>` as the package manager with
those args when the entrypoint is `pnpm.cjs`/`pnpm.js`/`pnpm.mjs`,
`npm-cli.js`, `yarn.js` or a yarn release `yarn-<version>.cjs`.
`nodeScriptOf` never treats such an entrypoint as a light script. The
install then takes the same path, charge and resources plan as the bare
command. An ordinary node script stays light.
