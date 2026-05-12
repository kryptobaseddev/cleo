# V2-RERUN Validation Report

**Date**: 2026-04-28  
**Validator**: V2-RERUN (validation subagent)  
**Commit under test**: `f3ec270ee` (sharedExternals fix adding `openai`, `@google/generative-ai`, `@anthropic-ai/sdk`)  
**Core version**: `2026.4.152`

---

## Summary

**BUG-2 (root barrel `Dynamic require of "stream"`) — FIXED**

The root barrel `import { sessions, tasks, Cleo } from '@cleocode/core'` now loads without any `Dynamic require of "stream"` error. The dist is pure ESM (zero `require()` calls in `dist/index.js`). Consumer test confirmed with `npx tsx --conditions=import`.

---

## Test Environment

```
Consumer: /tmp/v2-rerun (fresh pnpm package, type: "module")
Packages: @cleocode/core@2026.4.152, @cleocode/contracts@2026.4.152
Runtime: npx tsx --conditions=import
Node: v24.13.1
Build: pnpm --filter @cleocode/core run build → tsc (clean, exit 0)
```

---

## Step-by-Step Results

### Step 1: Build
```
pnpm --filter @cleocode/core run build
```
- **PASS** — `tsc` completed cleanly, `dist/index.js` present.

### Step 2: Consumer Setup
```
pnpm add /mnt/projects/cleocode/packages/core /mnt/projects/cleocode/packages/contracts
```
- **PASS** — both packages linked at v2026.4.152.

### Step 3 & 4: Root barrel import + session + task

```ts
import { sessions, tasks, Cleo } from '@cleocode/core';
const session = await sessions.startSession(projectRoot, { name: 'rerun', scope: 'global' });
const cleo = await Cleo.init(projectRoot);
const result = await cleo.tasks.add({ title: 'test add result', type: 'epic', ... });
await sessions.endSession(projectRoot, {});
```

Output:
```
session: session-1777336951951-edfb1c   ✅ (session created)
add() return type: object               ✅
add() return keys: [ 'task' ]           ⚠️  wrapped envelope (see BUG-1 below)
add() result.id: undefined              ⚠️  due to envelope wrapping
task stored correctly: T002 with 5 ACs  ✅ (confirmed via list())
OK
```

**No `Dynamic require of "stream"` — BUG-2 CONFIRMED FIXED.**

### Step 5: Stream Error Confirmation

`grep -c 'require(' dist/index.js` → `0` (zero CJS `require()` in dist)

### Step 6: `/internal` subpath

```ts
import * as internal from '@cleocode/core/internal';
```
- **PASS** — 1092 exports loaded, no stream errors, `has addTask: true`, `has sessions: true`, `has Cleo: true`.

---

## Bug Status

### BUG-2: Root Barrel `Dynamic require of "stream"` — **FIXED ✅**
The sharedExternals patch in `f3ec270ee` resolved this. Root barrel import works end-to-end.

### BUG-1: Acceptance Criteria Dropping — **STILL PRESENT (partially) ⚠️**
- Root cause: `cleo.tasks.add()` returns `{ task: { id, acceptance, ... } }` (LAFS envelope wrapper), **not** the task directly.
- Callers doing `result.id` or `result.acceptance` get `undefined`.
- **The data layer is fine** — acceptance criteria ARE stored and retrievable via `cleo.tasks.list()` or `cleo.tasks.show()`.
- This is a **return-shape mismatch** in the `Cleo` facade's `tasks.add()` method — it should either unwrap the envelope or document that callers must use `result.task.id`.

### BUG-3: Conduit Ops — **STILL PRESENT ⚠️**
- `conduitCoreOps` is a **type-only declaration** (`export declare const`) — it has no runtime value.  
  `'conduitCoreOps' in conduit` → `false` (expected).
- `cleo.conduit` is **not present** on the `Cleo` facade — conduit operations are not surfaced via the Cleo high-level API.
- The conduit module exports `ConduitClient`, `HttpTransport`, `LocalTransport`, `SseTransport`, `createConduit`, `resolveTransport` — these are the correct runtime exports for low-level usage.
- If `cleo.conduit` is intended to expose conduit ops, it needs to be added to the `Cleo` facade.

---

## Additional Notes

- `tsx` with the symlinked package source resolves `.ts` source files when tsconfig is in the consumer dir. Using `--conditions=import` forces the ESM dist resolution correctly.
- `cleo.tasks.get` does not exist — the correct method is `cleo.tasks.show`.
- `tasks.addTask(projectRoot, {...})` requires `title` as a positional string argument (not object property in some call paths) — the `Cleo.tasks.add()` wrapper is the correct consumer-facing API.
- Brain WARN logs about missing DB columns (ALTER TABLE) are benign runtime migrations on first use.

---

## Verdict

**V2-RERUN PARTIAL.** BUG-2 (root barrel stream error) is FIXED. BUG-1 (acceptance drop) persists as a return-shape mismatch in `Cleo.tasks.add()` envelope. BUG-3 (conduit ops empty on Cleo facade) persists.
