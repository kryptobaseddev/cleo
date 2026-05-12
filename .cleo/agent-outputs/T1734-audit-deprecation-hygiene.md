# T1734 Audit — dependency hygiene + deprecation chains

**Date**: 2026-05-02  
**Node version tested**: v24.13.1  
**Installed cleo version**: 2026.5.15  
**Source tree**: packages/core/package.json pinned at `openai: "^4.0.0"`  

---

## Live DEP warnings on cleo --version (current state)

Command run:
```
NODE_OPTIONS='--trace-deprecation --stack-trace-limit=200' node --disable-warning=ExperimentalWarning \
  /home/keatonhoskins/.npm-global/lib/node_modules/@cleocode/cleo/dist/cli/index.js --version
```

**Exactly 1 warning fires:**

```
(node:XXXX) [DEP0040] DeprecationWarning: The `punycode` module is deprecated.
Please use a userland alternative instead.
```

Full call stack (condensed — all frames belong to the same chain):

```
node:punycode:7                                    ← Node built-in punycode loaded
whatwg-url/lib/url-state-machine.js:2              ← required by whatwg-url@5
whatwg-url/lib/URL-impl.js:2
whatwg-url/lib/URL.js:5
whatwg-url/lib/public-api.js:3
node-fetch/lib/index.js:10                         ← node-fetch@2.7.0 requires whatwg-url@5
```

All paths resolve inside:
`/home/keatonhoskins/.npm-global/lib/node_modules/@cleocode/cleo/node_modules/`

The same single DEP0040 fires on `cleo briefing` — no additional codes appear.

**Total distinct DEP codes: 1 (DEP0040 only)**

---

## Will the openai 4→6 bump alone eliminate ALL of them?

**Yes — with one caveat about the installed binary vs the source tree.**

Reasoning:

The sole DEP0040 originates from this chain:

```
@cleocode/cleo CLI (dist/cli/index.js)
  → runtime import of @cleocode/core
    → openai@4.104.0 (external dep, loaded from node_modules at startup)
      → node-fetch@2.7.0 (dependency of openai@4)
        → whatwg-url@5.0.0 (dependency of node-fetch@2)
          → tr46@0.0.3 (dependency of whatwg-url@5)
            → require('punycode')   ← DEP0040 fires here
```

`openai@6.x` has **zero runtime dependencies** (confirmed: `npm view openai@6 dependencies` returns `{}`). It relies on the global `fetch` API available since Node 18. Bumping `packages/core/package.json` from `^4.0.0` → `^6` removes the entire chain: `node-fetch@2.7.0`, `whatwg-url@5.0.0`, `tr46@0.0.3`, and `@types/node-fetch@2.6.13` all become orphaned.

**Caveat**: The globally installed binary (`cleo` at `/home/keatonhoskins/.npm-global`) must be reinstalled after the bump and a new release is published. The source change alone does not update the live binary.

---

## Other punycode consumers (besides openai → node-fetch chain)

### `punycode` built-in (the deprecated one — triggers DEP0040)

Only two files in the entire installed dep tree call `require("punycode")`:

| File | Package |
|------|---------|
| `tr46/index.js` | `tr46@0.0.3` |
| `whatwg-url/lib/url-state-machine.js` | `whatwg-url@5.0.0` |

Both are pulled exclusively by `node-fetch@2.7.0`, which is pulled exclusively by `openai@4.104.0`. No other package in the tree uses the built-in `punycode` module.

### `punycode.js` (the userland replacement — safe, does NOT trigger DEP0040)

Found in the pnpm store: `punycode.js@2.3.1`

| Consumer | Why safe |
|----------|----------|
| `markdown-it@14.1.1` | imports `punycode.js` (the npm package, not the built-in) |
| `typedoc@0.28.17` (via markdown-it) | same |

`punycode.js` is a self-contained pure-JS implementation with no `require('punycode')` call internally. It does not trigger DEP0040.

---

## Other node-fetch@2 consumers (the same legacy fetch problem elsewhere)

**Only one consumer: `openai@4.104.0`.**

Evidence from pnpm lockfile and `node_modules/.pnpm` inspection:

```
openai@4.104.0  →  node-fetch: "^2.6.7"  →  node-fetch@2.7.0 installed
```

No other package in the dependency tree pins `node-fetch@2.x`. All other `node-fetch` consumers use `^3.x`:

| Consumer | node-fetch version required |
|----------|-----------------------------|
| `gaxios@7.1.4` (via `@mariozechner/pi-ai` → `@google/genai`) | `^3.3.2` |
| `node-fetch@3.3.2` | self |
| `drizzle-kit` | `^3.3.2` (dev only) |

`node-fetch@3` is ESM-native and has no deprecated-punycode dependency.

---

## Other whatwg-url@5 consumers

**Only one consumer: `node-fetch@2.7.0`.**

```
node-fetch@2.7.0  →  whatwg-url: "^5.0.0"  →  whatwg-url@5.0.0 installed
```

There is a separate `whatwg-url@7.x` or higher that is NOT present in this tree. The only `whatwg-url@5.0.0` instance is pulled by the single `node-fetch@2.7.0`, which is pulled only by `openai@4`.

---

## Known-bad transitive deps still in tree

| Package | Why bad | Pulled in by | Fix |
|---------|---------|--------------|-----|
| `node-fetch@2.7.0` | Legacy CJS, pulls `whatwg-url@5` + punycode chain | `openai@4.104.0` | T1734: bump openai 4→6 |
| `whatwg-url@5.0.0` | Requires `tr46@0.0.3` which calls `require('punycode')` | `node-fetch@2.7.0` | Eliminated by T1734 |
| `tr46@0.0.3` | Directly calls `require("punycode")` — the DEP0040 trigger | `whatwg-url@5.0.0` | Eliminated by T1734 |
| `abort-controller@3.0.0` | Polyfill now built into Node 18+ | `openai@4.104.0` (and `readable-stream`, `undici`, `node-fetch@3` as devDeps) | openai@6 drops it; residual consumers (`readable-stream@4`, `undici@7`) are transitive-only and Node provides the native API |
| `formdata-node@4.4.1` | Polyfill built into Node 18+ | `openai@4.104.0` (also `form-data-encoder`, `node-fetch@3`) | openai@6 drops it |
| `form-data-encoder@1.7.2` | Polyfill, only needed by openai@4 | `openai@4.104.0` | Eliminated by T1734 |
| `agentkeepalive@4.6.0` | HTTP keep-alive polyfill, only needed by openai@4 | `openai@4.104.0` | Eliminated by T1734 |
| `@types/node-fetch@2.6.13` | Dev type stubs for node-fetch@2 | `openai@4.104.0` | Eliminated by T1734 |

**No other known-bad packages found**: `request`, `rimraf@2`, `glob@7`, `inflight`, `tslib@1` are absent from the dependency tree. The tree is clean of the historical Node.js npm deprecations beyond the openai@4 chain.

---

## Direct-dep upgrade candidates that would simplify the tree

Only listing entries where a bump actively eliminates deprecated transitive deps or known-bad chains. Routine patch/minor bumps (svelte, vitest, typescript patch, etc.) are excluded — they do not affect deprecation hygiene.

| Direct dep | Current | Latest | Package | Removes which chains |
|------------|---------|--------|---------|---------------------|
| `openai` | `^4.0.0` | `6.35.0` | `packages/core` | **Entire DEP0040 chain**: `node-fetch@2.7.0`, `whatwg-url@5.0.0`, `tr46@0.0.3`, `abort-controller@3`, `formdata-node@4`, `form-data-encoder@1.7.2`, `agentkeepalive@4`, `@types/node-fetch@2.6.13` (8 packages) |
| `@google/generative-ai` | `^0.21.0` | `0.24.1` | `packages/core` | No deprecated chain eliminated; `@google/generative-ai@0.21.0` has zero deps. Minor bump is low risk but does not affect DEP warnings. |

**Note on `@ai-sdk/openai` major bump (2→3):** This appears in `pnpm outdated` as a major version change (`@cleocode/adapters`). However, current `@ai-sdk/openai@2` has only `@ai-sdk/provider` and `@ai-sdk/provider-utils` as deps — no deprecated transitive chain. The bump is not a deprecation-hygiene item.

---

## Recommended residual tasks (post-T1734)

1. **T1734 itself (in flight)**: Bump `packages/core` `openai ^4.0.0` → `^6`. This is the only change required to eliminate all DEP0040 emissions from the shipped CLI. After the bump, the following packages become orphaned and will be removed from the lockfile automatically: `node-fetch@2.7.0`, `whatwg-url@5.0.0`, `tr46@0.0.3`, `abort-controller@3.0.0`, `formdata-node@4.4.1`, `form-data-encoder@1.7.2`, `agentkeepalive@4.6.0`, `@types/node-fetch@2.6.13`. Effort: **small** (T1734 already in progress).

2. **Reinstall global binary after release**: The currently installed `cleo` binary at `~/.npm-global` still carries openai@4 in its bundled `node_modules`. After T1734 ships a new release, `npm install -g @cleocode/cleo@<new-version>` is required. Effort: **trivial** (one command, must be done by release process).

3. **No follow-up needed for `abort-controller`, `formdata-node`, `form-data-encoder`**: These will be swept automatically when openai@4 is removed. Other consumers (`readable-stream@4`, `undici@7`, `node-fetch@3`) retain a pin on `abort-controller@3` as a dev-graph dependency, but this does NOT trigger any DEP warning — `abort-controller@3` is a pure-JS shim that does not touch the built-in `punycode` or any deprecated Node API.

4. **Monitor `tr46` after T1734**: Run `ls node_modules/.pnpm | grep tr46` to confirm `tr46@0.0.3` is fully evicted. If it persists, a second consumer was introduced.

5. **Optional: bump `@google/generative-ai` `^0.21.0` → `^0.24.1`** in `packages/core`. Does not fix any deprecation but reduces version drift. The new `@google/genai` SDK (pulled by `@mariozechner/pi-ai`) is a separate package entirely and does not conflict. Effort: **small**, but not required for DEP hygiene.

---

## Summary

- **Unique live DEP codes**: 1 (DEP0040 only)  
- **Root cause**: single chain — `openai@4 → node-fetch@2 → whatwg-url@5 → tr46@0.0.3 → require('punycode')`  
- **T1734 scope is correct and sufficient**: bumping `openai ^4 → ^6` eliminates 100% of the observed deprecation warnings  
- **No other deprecated chains exist** in the current tree (`request`, `rimraf@2`, `glob@7`, `inflight`, `tslib@1` are all absent)  
- **Residual action**: reinstall global binary after T1734 release ships  
